#!/usr/bin/env node
/**
 * Scrape dropped-by tables THROUGH a Cloudflare Worker relay.
 *
 * The relay (deployed separately, see worker/relay.js) fetches Wowhead from
 * Cloudflare's egress IPs, so the per-IP rate limit on this machine's IP stops
 * mattering. The aws-waf-token cookie is minted locally with headless Edge and
 * forwarded with every relayed request; the token is not bound to IP (verified
 * in the repo), so this works across Cloudflare's pool.
 *
 * Env needed before launch:
 *   WOWHEAD_WORKER_URL  e.g. https://wowhead-relay.your-subdomain.workers.dev
 *   WOWHEAD_WORKER_KEY  the shared secret baked into the worker code
 *
 * Same checkpoint (data/item-drops.jsonl), same record shape, same merge as
 * scrape-drops.mjs / scrape-drops-browser.mjs — fully resumable.
 *
 * Usage:  node scripts/scrape-drops-worker.mjs [limit]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const jsonFile = join(root, 'data', 'items.json');
const jsonlFile = join(root, 'data', 'item-drops.jsonl');

function* readEnv(file) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) yield [m[1], m[2]];
  }
}
try {
  for (const [k, v] of readEnv(join(root, '.env'))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
} catch { /* fine */ }
if (process.env.MINT_FAILURE_BACKOFF_MS === undefined) process.env.MINT_FAILURE_BACKOFF_MS = '120000';
if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'error';

const WORKER_URL = process.env.WOWHEAD_WORKER_URL;
const WORKER_KEY = process.env.WOWHEAD_WORKER_KEY;
if (!WORKER_URL || !WORKER_KEY) {
  console.error('Set WOWHEAD_WORKER_URL and WOWHEAD_WORKER_KEY first, e.g.:');
  console.error('  $env:WOWHEAD_WORKER_URL = "https://wowhead-relay.<you>.workers.dev"');
  console.error('  $env:WOWHEAD_WORKER_KEY = "wfm-relay-k4t7q9x2"');
  process.exit(1);
}

const { loadEnv } = await import(pathToFileURL(join(root, 'dist', 'config.js')));
const { WowheadClient, HttpError } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'client.js')));
const { WafTokenStore, REAL_UA } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'token.js')));
const { parsePage, summarizeRow } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'parse.js')));
const { typeByName } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'types.js')));

const env = loadEnv();
const client = new WowheadClient(env);
const item = typeByName('item');
const globals = await client.globalNames();
const tokens = new WafTokenStore(
  env.WOWHEAD_TOKEN_FILE || join(homedir(), '.wowhead-token'),
  env.WOWHEAD_CHROME_PATH || undefined,
  env.WOWHEAD_TOKEN_MAX_AGE_HOURS,
  {
    mintUrl: env.WOWHEAD_MINT_URL || `${env.WOWHEAD_BASE_URL}/${env.WOWHEAD_ENV}/items`,
    deadlineMs: env.MINT_DEADLINE_MS,
    cookieWaitMs: env.MINT_COOKIE_WAIT_MS,
    callTimeoutMs: Math.max(5_000, Math.min(20_000, env.MINT_DEADLINE_MS - 5_000)),
  },
  env.MINT_FAILURE_BACKOFF_MS,
);

const PAUSE_MS = Number(process.env.CRAWL_PAUSE_MS ?? 50); // per worker
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 12);
const ROW_CAP = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warnings = [];

// ── Checkpoint (shared with the other scrapers) ─────────────────────────────
const done = new Set();
if (existsSync(jsonlFile)) {
  for (const line of readFileSync(jsonlFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!rec.failed) done.add(rec.itemId);
    } catch { /* torn line */ }
  }
}
console.error(`Resuming: ${done.size} items already scraped.`);

const data = JSON.parse(readFileSync(jsonFile, 'utf8'));
let targets = (data.items ?? []).filter(
  (it) => !it.nameSource && it.obtainedBy && /drop/i.test(it.obtainedBy) && !done.has(it.id),
);
const limit = Number(process.argv[2]);
if (Number.isFinite(limit) && limit > 0) targets = targets.slice(0, limit);
console.error(`${targets.length} farmable items to scrape (of ${(data.items ?? []).length}).`);

// ── Relay fetch ─────────────────────────────────────────────────────────────
async function fetchViaWorker(id, forceMint = false) {
  const token = await tokens.getOrMint(forceMint);
  if (!token) throw new Error('no WAF token available (mint failed)');
  const target = `${env.WOWHEAD_BASE_URL}/${env.WOWHEAD_ENV}/item=${id}`;
  const res = await fetch(`${WORKER_URL}?key=${encodeURIComponent(WORKER_KEY)}&url=${encodeURIComponent(target)}`, {
    headers: {
      'user-agent': REAL_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      cookie: `aws-waf-token=${token}`,
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function isChallenge(status, text) {
  return status === 202 || (status === 405 && text.includes('gokuProps')) || text.includes('gokuProps');
}

// ── Scrape (a pool of relay workers; Node serializes every sync step) ───────
let withTable = 0;
let withoutTable = 0;
let consecutiveFailures = 0;
let cooldownUntil = 0;
const npcIds = new Set();
const queue = [...targets];
let processed = 0;

async function worker() {
  for (let target = queue.shift(); target; target = queue.shift()) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const rec = { itemId: target.id, url: target.url };
  try {
    let page = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let r;
      // A plain 403 from a Cloudflare IP just means THAT IP is flagged — the
      // next relay request exits from a different one, so the cached token is
      // usually fine. Only force an expensive Edge re-mint on the last attempt
      // or when we get an actual challenge payload.
      const forceMint = attempt > 2;
      try {
        r = await fetchViaWorker(target.id, forceMint);
      } catch (err) {
        console.error(`  ! item ${target.id}: ${err instanceof Error ? err.message : err} — attempt ${attempt}`);
        await sleep(2_000 * attempt);
        continue;
      }
      if (r.status === 200 && !isChallenge(r.status, r.text)) {
        page = parsePage(r.text);
        consecutiveFailures = 0;
        break;
      }
      if (r.status === 404 && !isChallenge(r.status, r.text)) {
        rec.noDropTable = true;
        rec.reason = 'no page on Wowhead';
        withoutTable++;
        consecutiveFailures = 0;
        break;
      }
      console.error(`  ! item ${target.id}: HTTP ${r.status}${r.text.includes('gokuProps') ? ' (challenge)' : ''} — attempt ${attempt}`);
      // Challenge payload = the token itself was rejected upstream: mint fresh.
      await sleep(1_500 * attempt);
    }

    if (page) {
      const lv = page.listviews.find((l) => l.id.toLowerCase() === 'dropped-by');
      if (!lv || lv.rows.length === 0) {
        rec.noDropTable = true;
        rec.reason = 'Wowhead lists no droppers';
        withoutTable++;
      } else {
        const pageNames = new Map(Object.entries(page.names ?? {}));
        for (const k of Object.keys(pageNames)) {
          const [t, nid] = k.split(':');
          if (t === '1' && !Number.isNaN(Number(nid))) npcIds.add(Number(nid));
        }
        const shaped = lv.rows.map((row) => summarizeRow(row, lv.template));
        shaped.sort((a, b) => {
          const solid = (x) => (typeof x['samples'] === 'number' && x['samples'] >= (env.DROP_MIN_SAMPLES ?? 20) ? 0 : 1);
          const chance = (x) => parseFloat(String(x['dropChance'] ?? '').replace('%', '')) || 0;
          return solid(a) - solid(b) || chance(b) - chance(a);
        });
        rec.droppedByRows = shaped.length;
        rec.droppedBy = shaped.slice(0, ROW_CAP).map((row) => {
          const zones = (Array.isArray(row['location']) ? row['location'] : [])
            .map((z) => globals.areas.get(Number(z)))
            .filter(Boolean);
          const npcId = Number(row['id']);
          if (Number.isFinite(npcId) && npcId > 0) {
            npcIds.add(npcId);
            if (pageNames.has(`1:${npcId}`)) row.npcName = pageNames.get(`1:${npcId}`);
            row.npcUrl = client.pageUrl('npc', npcId);
          }
          return {
            npcId: Number.isFinite(npcId) ? npcId : undefined,
            npcName: row['npcName'],
            npcUrl: row['npcUrl'],
            npcLevel: row['level'],
            npcRank: row['rank'],
            zones,
            dropChance: row['dropChance'],
            samples: row['samples'],
          };
        });
        if (rec.droppedByRows > rec.droppedBy.length) rec.droppedByTruncated = rec.droppedByRows - rec.droppedBy.length;
        withTable++;
      }
    }
  } catch (err) {
    warnings.push(`FAILED ${target.url}: ${err instanceof Error ? err.message : String(err)}`);
    consecutiveFailures++;
    if (consecutiveFailures >= 10) {
      // All workers share one cooldown: hammering while others fail helps nobody.
      cooldownUntil = Date.now() + 600_000;
      consecutiveFailures = 0;
      console.error('10 consecutive failures across workers — cooling down 10 min');
    }
    continue; // failed items stay queued for a rerun
  }
  if (!rec.droppedBy && !rec.noDropTable) {
    // All attempts got refused (403 storm) and nothing was learned: NOT a done
    // item. Checkpointing it here would make every later sweep skip it forever.
    consecutiveFailures++;
    if (consecutiveFailures >= 10) {
      cooldownUntil = Date.now() + 600_000;
      consecutiveFailures = 0;
      console.error('10 consecutive refusals across workers — cooling down 10 min');
    }
    continue;
  }
  appendFileSync(jsonlFile, JSON.stringify(rec) + '\n');
  done.add(target.id);
  processed++;
  if (processed % 200 === 0) {
    console.error(`  ${done.size} done (tables: ${withTable}, no table: ${withoutTable}, warnings: ${warnings.length})`);
  }
  await sleep(PAUSE_MS);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.error(`Crawl done: ${withTable} with tables, ${withoutTable} without, ${warnings.length} warnings.`);

// ── Name the NPCs (tooltip service, unaffected) ─────────────────────────────
const knownNames = new Map();
for (const line of readFileSync(jsonlFile, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    for (const d of JSON.parse(line).droppedBy ?? []) {
      if (d.npcId) npcIds.add(d.npcId);
      if (d.npcId && d.npcName) knownNames.set(d.npcId, d.npcName);
    }
  } catch { /* torn line */ }
}
const unknown = [...npcIds].filter((id) => !knownNames.has(id));
console.error(`Resolving names for ${unknown.length} NPCs (tooltip service, 6 concurrent)...`);
const nameQueue = [...unknown];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let id = nameQueue.shift(); id !== undefined; id = nameQueue.shift()) {
      const name = await client.entityName(1, id).catch(() => undefined);
      if (name) knownNames.set(id, name);
    }
  }),
);
console.error(`Resolved ${knownNames.size}/${npcIds.size} NPC names.`);

// ── Merge into items.json (+ CSV) ───────────────────────────────────────────
const byId = new Map((data.items ?? []).map((it) => [it.id, it]));
let attached = 0;
const allLines = readFileSync(jsonlFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
for (const line of allLines) {
  try {
    const rec = JSON.parse(line);
    const target = byId.get(rec.itemId);
    if (!target) continue;
    if (rec.droppedBy?.length) {
      target.droppedByRows = rec.droppedByRows;
      target.droppedBy = rec.droppedBy.map((d) => ({ ...d, npcName: d.npcName ?? knownNames.get(d.npcId ?? -1) }));
      if (rec.droppedByTruncated) target.droppedByTruncated = rec.droppedByTruncated;
      attached++;
    } else if (rec.noDropTable) {
      target.noDropTable = true;
    }
  } catch { /* torn line */ }
}
data.scrapedAt = new Date().toISOString();
data.dropsScraped = { items: allLines.length, withTable: attached, warnings };
writeFileSync(jsonFile, JSON.stringify(data, null, 1));

const CSV_COLUMNS = [
  'id', 'name', 'quality', 'itemLevel', 'requiredLevel', 'slot', 'dps', 'speed',
  'damageMin', 'damageMax', 'armor', 'stats', 'obtainedBy', 'from', 'zone', 'sellPrice', 'url', 'slug',
  'dropNpc', 'dropNpcUrl', 'dropChance', 'dropSamples', 'dropZones',
];
const cell = (v) => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const lines = [CSV_COLUMNS.join(',')];
for (const it of byId.values()) {
  const base = CSV_COLUMNS.slice(0, 18).map((c) => cell(it[c]));
  const drops = it.droppedBy ?? [];
  if (drops.length === 0) {
    lines.push(base.join(','));
  } else {
    for (const d of drops) {
      lines.push(
        [...base, d.npcName ?? d.npcId ?? '', d.npcUrl ?? '', d.dropChance ?? '', d.samples ?? '', (d.zones ?? []).join('; ')]
          .map(cell)
          .join(','),
      );
    }
  }
}
writeFileSync(join(root, 'data', 'items.csv'), lines.join('\n'));

console.error('');
console.error(`Items with drop tables : ${attached}`);
console.error(`Unique NPC names known : ${knownNames.size}/${npcIds.size}`);
console.error(`Warnings               : ${warnings.length}`);
console.error(`Files                  : ${jsonFile} (+ item-drops.jsonl checkpoint)`);
