#!/usr/bin/env node
/**
 * Read the item and NPC pages that are due, through the Cloudflare relay.
 *
 * Items: every id in data/items.json (the listing plus the sitemap). An item
 * page holds every table that says where the item comes from, so each one is
 * read on a schedule, freshest data first:
 *   - never read yet:                   now (items the listing calls drops first)
 *   - has a drop table:                 every day (drop chances keep moving)
 *   - other sources (vendor, quest...): every 3 days
 *   - nothing at all:                   every 14 days
 * NPCs: every NPC those tables mention; a page adds its spawn points. Every 7 days.
 * Budgets cap a run; whatever isn't read stays as it was in the previous snapshot.
 *
 * A page that can't be read is retried at the end of the run with fewer workers.
 * What still fails is listed in run.json (and the snapshot keeps the previous
 * day's data for it), never dropped silently.
 *
 * Usage:  node scripts/scrape-pages.mjs [--prev <previous snapshot dir>]
 * Env:    WOWHEAD_WORKER_URL / WOWHEAD_WORKER_KEY   the relay (else pages are fetched directly)
 *         ITEM_PAGE_BUDGET (14000)  NPC_PAGE_BUDGET (4000)  CRAWL_CONCURRENCY (12)
 *         CRAWL_PAUSE_MS (50)  CRAWL_DEADLINE_MIN (200)
 * Writes: data/pages/items.jsonl, npcs.jsonl (checkpoints; a rerun the same day resumes),
 *         data/pages/areas.json, data/pages/run.json
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = (p) => pathToFileURL(join(root, 'dist', p));

function* readEnvFile(file) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) yield [m[1], m[2]];
  }
}
try {
  for (const [k, v] of readEnvFile(join(root, '.env'))) if (process.env[k] === undefined) process.env[k] = v;
} catch { /* no .env */ }
if (process.env.MINT_FAILURE_BACKOFF_MS === undefined) process.env.MINT_FAILURE_BACKOFF_MS = '120000';
if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'error';

const { loadEnv } = await import(dist('config.js'));
const { WafTokenStore, REAL_UA } = await import(dist('wowhead/token.js'));
const { WowheadClient } = await import(dist('wowhead/client.js'));
const { parseItemPage, parseNpcPage, LOOT_TARGET } = await import(dist('wowhead/pages.js'));
const { relayFromEnv, RELAY_KEY_HEADER } = await import(dist('wowhead/relay.js'));
const { FILES, readJsonlSync, snapshotSchema, today, daysBetween } = await import(dist('snapshot.js'));

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prevDir = opt('--prev');
const dataDir = opt('--data') ?? join(root, 'data');
/** A non-negative number from the environment; unset or empty means the default. */
const intEnv = (name, dflt) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const ITEM_BUDGET = intEnv('ITEM_PAGE_BUDGET', 14000);
const NPC_BUDGET = intEnv('NPC_PAGE_BUDGET', 4000);
const CONCURRENCY = Math.max(1, intEnv('CRAWL_CONCURRENCY', 12));
const PAUSE_MS = intEnv('CRAWL_PAUSE_MS', 50);
const DEADLINE = Date.now() + intEnv('CRAWL_DEADLINE_MIN', 200) * 60_000;
const REFRESH_DAYS = { drops: 1, sources: 3, none: 14, npc: 7 };

const env = loadEnv();
const relay = relayFromEnv();
const base = `${env.WOWHEAD_BASE_URL}/${env.WOWHEAD_ENV}`;
const outDir = join(dataDir, 'pages');
mkdirSync(outDir, { recursive: true });
const itemsCheckpoint = join(outDir, 'items.jsonl');
const npcsCheckpoint = join(outDir, 'npcs.jsonl');
const date = today();
const startedAt = new Date();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

// ── Inputs ───────────────────────────────────────────────────────────────────
const listing = JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8'));
const allItems = (listing.items ?? []).filter((it) => Number.isInteger(it.id) && it.id > 0);
log(`${allItems.length} items in the listing and sitemap.`);

const prevSources = new Map();
const prevNpcs = new Map();
if (prevDir && snapshotSchema(prevDir) >= 2) {
  for (const r of readJsonlSync(join(prevDir, FILES.pages))) prevSources.set(r.id, r);
  for (const r of readJsonlSync(join(prevDir, FILES.npcs))) prevNpcs.set(r.id, r);
  log(`Previous snapshot: ${prevSources.size} item pages, ${prevNpcs.size} NPCs.`);
} else {
  log(prevDir ? `No schema 2 snapshot in ${prevDir}: every page is due.` : 'No --prev: every page is due.');
}

// Pages already read today (a rerun after an interruption).
const doneToday = (file) => {
  const done = new Map();
  for (const r of readJsonlSync(file)) if (r.fetchedAt === date) done.set(r.id, r);
  return done;
};
const itemsDone = doneToday(itemsCheckpoint);
const npcsDone = doneToday(npcsCheckpoint);
if (itemsDone.size || npcsDone.size) log(`Resuming: ${itemsDone.size} item and ${npcsDone.size} NPC pages already read today.`);

// ── Fetching ─────────────────────────────────────────────────────────────────
const tokens = new WafTokenStore(
  env.WOWHEAD_TOKEN_FILE || join(homedir(), '.wowhead-token'),
  env.WOWHEAD_CHROME_PATH || undefined,
  env.WOWHEAD_TOKEN_MAX_AGE_HOURS,
  {
    mintUrl: env.WOWHEAD_MINT_URL || `${base}/items`,
    deadlineMs: env.MINT_DEADLINE_MS,
    cookieWaitMs: env.MINT_COOKIE_WAIT_MS,
    callTimeoutMs: Math.max(5_000, Math.min(20_000, env.MINT_DEADLINE_MS - 5_000)),
  },
  env.MINT_FAILURE_BACKOFF_MS,
);

const isChallenge = (status, text) => status === 202 || text.includes('gokuProps');

async function fetchOnce(url, forceMint) {
  const token = await tokens.getOrMint(forceMint);
  if (!token) throw new Error('no WAF token (mint failed)');
  const headers = {
    'user-agent': REAL_UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    cookie: `aws-waf-token=${token}`,
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'upgrade-insecure-requests': '1',
  };
  const res = relay
    ? await fetch(`${relay.url}?url=${encodeURIComponent(url)}`, {
        headers: { ...headers, [RELAY_KEY_HEADER]: relay.key },
        signal: AbortSignal.timeout(30_000),
      })
    : await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text() };
}

/**
 * One page: { html } on success, { missing: true } for a real 404, or
 * { error } after `attempts` refusals (403 storms, challenges, timeouts).
 */
async function fetchPage(url, attempts) {
  let last = 'no attempt';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // A plain 403 means the Cloudflare IP that served it is flagged; the next
      // request leaves from another one. Re-mint only on a challenge or late on.
      const r = await fetchOnce(url, attempt >= 3);
      if (r.status === 200 && !isChallenge(r.status, r.text)) return { html: r.text };
      if (r.status === 404 && !isChallenge(r.status, r.text)) return { missing: true };
      last = `HTTP ${r.status}${isChallenge(r.status, r.text) ? ' (challenge)' : ''}`;
      if (isChallenge(r.status, r.text)) await tokens.getOrMint(true);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(1_500 * attempt);
  }
  return { error: last };
}

/**
 * Run `work(id)` over `ids` with a worker pool. `work` returns 'ok' or 'failed'.
 * Ten failures in a row (across workers) pause everyone for a few minutes.
 */
async function crawl(ids, work, { concurrency, label }) {
  const queue = [...ids];
  let streak = 0;
  let cooldownUntil = 0;
  let processed = 0;
  let stoppedAt;
  const failed = [];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (Date.now() > DEADLINE) {
        stoppedAt ??= queue.length + 1;
        queue.length = 0;
        return;
      }
      const wait = cooldownUntil - Date.now();
      if (wait > 0) await sleep(wait);
      const result = await work(id);
      if (result === 'failed') {
        failed.push(id);
        if (++streak >= 10) {
          streak = 0;
          cooldownUntil = Date.now() + 180_000;
          log(`  10 failures in a row: pausing ${label} for 3 minutes`);
        }
      } else {
        streak = 0;
      }
      if (++processed % 500 === 0) log(`  ${label}: ${processed}/${ids.length} (failed so far: ${failed.length})`);
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length || 1) }, worker));
  return { failed, notReached: stoppedAt ?? 0 };
}

/** Main pass, then the failures again: after a pause, with 4 workers and more attempts. */
async function crawlWithRetry(ids, readOne, label) {
  const stats = { attempted: 0, ok: 0, missing: 0, unparsed: 0, failedIds: [], errors: {}, notReached: 0 };
  const work = (attempts) => async (id) => {
    const r = await readOne(id, attempts);
    if (r.error) {
      stats.errors[r.error] = (stats.errors[r.error] ?? 0) + 1;
      return 'failed';
    }
    if (r.unparsed) {
      stats.unparsed++;
      return 'failed';
    }
    if (r.missing) stats.missing++;
    else stats.ok++;
    return 'ok';
  };
  stats.attempted = ids.length;
  const first = await crawl(ids, work(3), { concurrency: CONCURRENCY, label });
  stats.notReached = first.notReached;
  let failed = first.failed;
  if (failed.length && Date.now() < DEADLINE) {
    log(`  ${label}: retrying ${failed.length} failed pages in 60 s with 4 workers...`);
    await sleep(60_000);
    stats.unparsed = 0;
    stats.errors = {};
    const second = await crawl(failed, work(5), { concurrency: 4, label: `${label} retry` });
    failed = second.failed;
  }
  stats.failedIds = failed.sort((a, b) => a - b);
  return stats;
}

// ── Items ────────────────────────────────────────────────────────────────────
function itemDue(it) {
  const prev = prevSources.get(it.id);
  const listedDrop = /drop/i.test(it.obtainedBy ?? '');
  if (!prev) return { id: it.id, rank: listedDrop ? 0 : 1, age: Infinity };
  const age = daysBetween(prev.fetchedAt, date);
  const kind = prev.droppedBy?.length ? 'drops' : Object.keys(prev).some((k) => !['id', 'fetchedAt', 'missing', 'self', 'truncated'].includes(k)) ? 'sources' : 'none';
  return age >= REFRESH_DAYS[kind] ? { id: it.id, rank: 2, age } : undefined;
}
const dueItems = allItems
  .filter((it) => !itemsDone.has(it.id))
  .map(itemDue)
  .filter(Boolean)
  .sort((a, b) => a.rank - b.rank || b.age - a.age || a.id - b.id);
const itemTargets = dueItems.slice(0, ITEM_BUDGET).map((d) => d.id);
log(`Items due: ${dueItems.length}; reading ${itemTargets.length} (budget ${ITEM_BUDGET}).`);

const listviewIds = {};
let itemsWithoutListviews = 0;
const freshItems = new Map(itemsDone);

async function readItem(id, attempts) {
  const r = await fetchPage(`${base}/item=${id}`, attempts);
  if (r.error) return r;
  let rec;
  if (r.missing) {
    rec = { id, fetchedAt: date, missing: true };
  } else {
    const page = parseItemPage(r.html, id);
    if (!page) return { unparsed: true };
    const nLv = Object.keys(page.listviews).length;
    if (nLv === 0) itemsWithoutListviews++;
    for (const k of Object.keys(page.listviews)) listviewIds[k] = (listviewIds[k] ?? 0) + 1;
    rec = { id, fetchedAt: date, page };
  }
  appendFileSync(itemsCheckpoint, JSON.stringify(rec) + '\n');
  freshItems.set(id, rec);
  return r.missing ? { missing: true } : {};
}

const itemStats = await crawlWithRetry(itemTargets, readItem, 'item pages');
itemStats.due = dueItems.length;
itemStats.budget = ITEM_BUDGET;
itemStats.skippedForBudget = Math.max(0, dueItems.length - itemTargets.length);
itemStats.withoutListviews = itemsWithoutListviews;
log(`Item pages: ${itemStats.ok} read, ${itemStats.missing} not on Wowhead, ${itemStats.failedIds.length} failed, ${itemStats.notReached} not reached.`);

// ── NPCs ─────────────────────────────────────────────────────────────────────
// Every NPC the item tables point at, using today's page where there is one.
const npcIds = new Set();
const npcTables = Object.entries(LOOT_TARGET).filter(([, t]) => t === 'npc').map(([k]) => k);
const addNpcsOf = (sources) => {
  if (!sources) return;
  for (const key of [...npcTables, 'soldBy']) for (const row of sources[key] ?? []) npcIds.add(row[0]);
};
for (const it of allItems) {
  const fresh = freshItems.get(it.id);
  addNpcsOf(fresh ? fresh.page?.sources : prevSources.get(it.id));
}
const dueNpcs = [...npcIds]
  .filter((id) => !npcsDone.has(id))
  .map((id) => {
    const prev = prevNpcs.get(id);
    const age = daysBetween(prev?.pageFetchedAt, date);
    return age >= REFRESH_DAYS.npc ? { id, rank: prev?.pageFetchedAt ? 1 : 0, age } : undefined;
  })
  .filter(Boolean)
  .sort((a, b) => a.rank - b.rank || b.age - a.age || a.id - b.id);
const npcTargets = dueNpcs.slice(0, NPC_BUDGET).map((d) => d.id);
log(`NPCs referenced: ${npcIds.size}; due ${dueNpcs.length}; reading ${npcTargets.length} (budget ${NPC_BUDGET}).`);

async function readNpc(id, attempts) {
  const r = await fetchPage(`${base}/npc=${id}`, attempts);
  if (r.error) return r;
  let rec;
  if (r.missing) {
    rec = { id, fetchedAt: date, missing: true };
  } else {
    const page = parseNpcPage(r.html, id);
    if (!page) return { unparsed: true };
    rec = { id, fetchedAt: date, page };
  }
  appendFileSync(npcsCheckpoint, JSON.stringify(rec) + '\n');
  return r.missing ? { missing: true } : {};
}

const npcStats = await crawlWithRetry(npcTargets, readNpc, 'NPC pages');
npcStats.referenced = npcIds.size;
npcStats.due = dueNpcs.length;
npcStats.budget = NPC_BUDGET;
npcStats.skippedForBudget = Math.max(0, dueNpcs.length - npcTargets.length);
log(`NPC pages: ${npcStats.ok} read, ${npcStats.missing} not on Wowhead, ${npcStats.failedIds.length} failed, ${npcStats.notReached} not reached.`);

// ── Zone names (one request to the tooltip service) ──────────────────────────
try {
  const client = new WowheadClient(env);
  const globals = await client.globalNames();
  writeFileSync(join(outDir, 'areas.json'), JSON.stringify(Object.fromEntries(globals.areas)));
} catch (err) {
  log(`Couldn't load zone names: ${err instanceof Error ? err.message : err}`);
}

const finishedAt = new Date();
const run = {
  date,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  minutes: Math.round((finishedAt - startedAt) / 6000) / 10,
  relay: !!relay,
  items: { ...itemStats, failed: itemStats.failedIds.length, failedIds: itemStats.failedIds.slice(0, 100) },
  npcs: { ...npcStats, failed: npcStats.failedIds.length, failedIds: npcStats.failedIds.slice(0, 100) },
  listviewIds,
};
writeFileSync(join(outDir, 'run.json'), JSON.stringify(run, null, 1));
log(`Done in ${run.minutes} min.`);
