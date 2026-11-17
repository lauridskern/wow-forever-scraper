#!/usr/bin/env node
/**
 * Scrape EVERY item in the Wowhead Forever item listing into data/items.json
 * (an intermediate file: the snapshot itself is built by scripts/build-snapshot.mjs).
 *
 * Wowhead never displays more than 1000 rows per listing page (23,758 items as
 * of writing), so this walks a partition tree instead of one page:
 *
 *   1. the unfiltered /forever/items listing  -> grand total
 *   2. one chunk per quality (0 Poor ... 6 Artifact) via the `quality:n` filter
 *   3. any chunk over the 1000-row cap is split in half on `min/max-req-level`
 *      (items with no required level count as 0, as Wowhead itself treats them)
 *   4. a window that has collapsed to a single req-level but is still over the
 *      cap (e.g. 5,685 common items with NO required level) is fixed at that
 *      value and split instead on `min/max-level` — the item level
 *   5. as a safety net, if the quality buckets don't account for the grand
 *      total (Heirloom has no working quality filter here), the whole tree is
 *      walked once more WITHOUT the quality filter, and unseen ids are added.
 *
 * Every chunk is verified: only filters Wowhead reports as applied are trusted
 * (Wowhead applies only the FIRST occurrence of each filter key, so every
 * node's filter list is rebuilt, never accumulated), items are deduped by id,
 * and the final count is reconciled against Wowhead's own grand total.
 * Progress is checkpointed to data/items.json after every quality bucket.
 *
 * Usage:  node scripts/scrape-items.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'data');
const jsonFile = join(outDir, 'items.json');

// Load .env before loadEnv() reads process.env.
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
} catch {
  /* no .env — fine */
}
// A failed token mint must not block recovery for the default 10 minutes.
if (process.env.MINT_FAILURE_BACKOFF_MS === undefined) process.env.MINT_FAILURE_BACKOFF_MS = '20000';

const { loadEnv } = await import(pathToFileURL(join(root, 'dist', 'config.js')));
const { WowheadClient, HttpError } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'client.js')));
const { buildRecords } = await import(pathToFileURL(join(root, 'dist', 'browse.js')));
const { specForPath } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'listing.js')));
const { QUALITY_NAMES } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'types.js')));
const { presentListingRow } = await import(pathToFileURL(join(root, 'dist', 'present.js')));

const env = loadEnv();

// When WOWHEAD_WORKER_URL/KEY are set (CI), route www.wowhead.com page fetches
// through the Cloudflare relay: Actions runners sit on Azure datacenter IPs,
// which Wowhead's edge throttles directly. Token minting and the tooltip
// service (nether.wowhead.com) stay direct — they were never throttled.
const { relayFromEnv, relayedFetch } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'relay.js')));
const relay = relayFromEnv();
const client = relay ? new WowheadClient(env, { fetch: relayedFetch(relay, env.WOWHEAD_BASE_URL) }) : new WowheadClient(env);
const spec = specForPath('items');
const globals = await client.globalNames();
const ctx = { globals, names: new Map(), pageUrl: (p, id) => client.pageUrl(p, id) };

const CAP = 1000; // Wowhead's own listing cap
const PAUSE_MS = 600; // be polite; Wowhead's edge throttles rapid listing bursts
const MAX_DEPTH = 20; // split depth guard: req-level needs ~7, item-level ~9

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warnings = [];

/**
 * Fetch one chunk and present its rows. `filters` are Wowhead path filter
 * segments; every one of them must show up in the page's own applied-filter
 * list, otherwise the chunk is unfiltered and would double-count.
 * An empty window (no matching items) is a clean 404: empty chunk, not an error.
 * Transient refusals (403/challenge bursts, a failed token mint) are retried
 * with a growing pause; Wowhead's edge sometimes stumbles under a long run.
 */
async function fetchChunk(filters, attempts = 4) {
  const url = client.listingUrl('items', filters);
  for (let attempt = 1; ; attempt++) {
    try {
      const page = await client.listing('items', filters);
      const built = buildRecords(page, spec);
      const applied = new Set(page.activeFilters ?? []);
      const notApplied = filters.filter((f) => !applied.has(f));
      const items = built.records.map((r) =>
        presentListingRow(
          { row: r.row, ...(r.record ? { record: r.record } : {}), template: 'item', entity: 'item' },
          ctx,
        ),
      );
      return { url, items, total: built.totalFound ?? built.records.length, truncated: built.truncated === true, notApplied };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return { url, items: [], total: 0, truncated: false, notApplied: [] };
      }
      if (attempt >= attempts) throw err;
      const wait = 5_000 * attempt * attempt;
      console.error(`  ! ${err.message} — retry ${attempt}/${attempts - 1} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

/** Splitting dimensions, in order. A window narrower than its dimension's range. */
const REQ_LEVEL = { kind: 'range', name: 'required level', min: 'min-req-level', max: 'max-req-level', lo: 0, hi: 100 };
const ITEM_LEVEL = { kind: 'range', name: 'item level', min: 'min-level', max: 'max-level', lo: 0, hi: 300 };
// Vendor trash and quest items share req-level AND item level, so numeric
// windows exhaust; item class and slot are discrete escape hatches. Invalid
// values are simply not applied by Wowhead and get skipped, never mis-scraped.
const ITEM_CLASS = { kind: 'values', name: 'item class', filter: 'class', values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16] };
const SLOT = { kind: 'values', name: 'slot', filter: 'slot', values: Array.from({ length: 28 }, (_, i) => i) };

/**
 * Scrape one partition subtree. `prefix` holds fixed filters (quality, plus any
 * expanded discrete value); `pinned` holds collapsed numeric dimensions pinned
 * at a single value; `dims` are the remaining splitting dimensions, the first
 * of which owns the current window. The filter list is always REBUILT from the
 * node's own state — Wowhead applies only the FIRST occurrence of each filter
 * key in the path, so inherited bounds would silently override the child's
 * narrower ones.
 */
async function scrapeTree(prefix, pinned, dims, depth = 0) {
  const filtersFor = (first) => {
    const out = [...prefix, ...pinned];
    if (first?.kind === 'range') {
      if (first.lo > 0) out.push(`${first.min}:${first.lo}`);
      if (first.hi < Number.POSITIVE_INFINITY) out.push(`${first.max}:${first.hi}`);
    }
    return out;
  };

  let chunk;
  try {
    chunk = await fetchChunk(filtersFor(dims[0]));
  } catch (err) {
    // One dead chunk must not kill a long run: record it, keep going, and the
    // reconciliation warning at the end says exactly which window to re-run.
    warnings.push(`Chunk failed permanently: ${err instanceof Error ? err.message : String(err)} (${client.listingUrl('items', filtersFor(dims[0]))})`);
    return { items: [], leafTotals: [], appliedLeaves: 0 };
  }
  if (chunk.notApplied.length > 0) {
    warnings.push(`Wowhead ignored ${chunk.notApplied.join(', ')} on ${chunk.url} — chunk skipped to avoid duplicates`);
    return { items: [], leafTotals: [], appliedLeaves: 0 };
  }
  await sleep(PAUSE_MS);

  const overCap = chunk.items.length >= CAP || chunk.truncated;
  if (!overCap || depth >= MAX_DEPTH || dims.length === 0) {
    if (overCap) {
      warnings.push(`Filters [${filtersFor(dims[0]).join('/')}] still hold ${chunk.total} rows after all splits — results are partial there (${chunk.url})`);
    }
    return { items: chunk.items, leafTotals: [chunk.total], appliedLeaves: 1 };
  }

  const [dim, ...rest] = dims;
  // A discrete dimension is not split but expanded: one subtree per value.
  // (An unsupported value is skipped inside the child, by the applied check.)
  if (dim.kind === 'values') {
    const merged = { items: [], leafTotals: [], appliedLeaves: 0 };
    for (const v of dim.values) {
      const child = await scrapeTree([...prefix, `${dim.filter}:${v}`], pinned, rest, depth + 1);
      merged.items.push(...child.items);
      merged.leafTotals.push(...child.leafTotals);
      merged.appliedLeaves += child.appliedLeaves;
    }
    return merged;
  }
  // A numeric dimension with no width left is a fact, not a window: pin it.
  if (dim.hi <= dim.lo) {
    return scrapeTree(prefix, [...pinned, `${dim.min}:${dim.lo}`, `${dim.max}:${dim.lo}`], rest, depth + 1);
  }

  const mid = Math.max(dim.lo + 1, Math.round((dim.lo + dim.hi) / 2));
  const loTree = await scrapeTree(prefix, pinned, [{ ...dim, hi: mid - 1 }, ...rest], depth + 1);
  const hiTree = await scrapeTree(prefix, pinned, [{ ...dim, lo: mid }, ...rest], depth + 1);
  return {
    items: [...loTree.items, ...hiTree.items],
    leafTotals: [...loTree.leafTotals, ...hiTree.leafTotals],
    appliedLeaves: loTree.appliedLeaves + hiTree.appliedLeaves,
  };
}

// ── 1. Grand total ──────────────────────────────────────────────────────────
console.error('Fetching the unfiltered items listing for the grand total...');
const grand = await fetchChunk([]);
if (grand.notApplied.length > 0 || grand.items.length === 0) {
  console.error('The unfiltered listing could not be read; aborting rather than scraping partial data.');
  process.exit(1);
}
const grandTotal = grand.total;
console.error(`Wowhead reports ${grandTotal} items in total.`);

// ── Output helpers ──────────────────────────────────────────────────────────
const byId = new Map();
const chunksSeen = [];
let leafTotalSum = 0;
let leafCount = 0;

function save(items) {
  const payload = {
    scrapedAt: new Date().toISOString(),
    totalOnWowhead: grandTotal,
    uniqueItemsScraped: items.size,
    chunks: chunksSeen,
    warnings,
    items: [...items.values()].sort((a, b) => a.id - b.id),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(jsonFile, JSON.stringify(payload, null, 1));
}

function absorb(tree, label, probeTotal) {
  let added = 0;
  for (const item of tree.items) {
    const id = Number(/item=(\d+)/.exec(item.url ?? '')?.[1] ?? NaN);
    if (!Number.isFinite(id)) continue; // rows without a resolvable id are variants already folded away
    if (byId.has(id)) continue;
    byId.set(id, { id, ...item });
    added++;
  }
  leafTotalSum += tree.leafTotals.reduce((a, b) => a + b, 0);
  leafCount += tree.appliedLeaves;
  chunksSeen.push({ quality: label, total: probeTotal, scrapedFrom: tree.items.length, added, leaves: tree.appliedLeaves });
  console.error(`  -> ${added} new unique items (running total ${byId.size})`);
}

// ── 2+3+4. Quality buckets, adaptively split ───────────────────────────────
for (let q = 0; q < QUALITY_NAMES.length; q++) {
  const label = QUALITY_NAMES[q];
  const probe = await fetchChunk([`quality:${q}`]);
  await sleep(PAUSE_MS);
  if (probe.notApplied.length > 0) {
    warnings.push(`The quality:${q} filter was not applied by Wowhead — ${label} items were not scraped.`);
    continue;
  }
  console.error(`Quality ${label}: ${probe.total} items${probe.items.length >= CAP ? ' (needs splitting)' : ''}`);

  let tree;
  if (probe.items.length >= CAP || probe.truncated) {
    tree = await scrapeTree([`quality:${q}`], [], [REQ_LEVEL, ITEM_LEVEL, ITEM_CLASS, SLOT]);
  } else {
    tree = { items: probe.items, leafTotals: [probe.total], appliedLeaves: 1 };
  }
  absorb(tree, label, probe.total);

  // Checkpoint after every quality bucket.
  save(byId);
}

// ── 5. Safety net: a full pass without the quality filter ───────────────────
// Qualities whose filter Wowhead ignores (Heirloom here) are invisible to the
// buckets above; a plain req-level/item-level partition of /items covers them.
if (leafTotalSum < grandTotal) {
  console.error(`\nQuality buckets account for ${leafTotalSum}/${grandTotal} — running a fallback pass over the unfiltered listing...`);
  const fallback = await scrapeTree([], [], [REQ_LEVEL, ITEM_LEVEL, ITEM_CLASS, SLOT]);
  absorb(fallback, '(fallback: no quality filter)', undefined);
  save(byId);
}

// ── Reconciliation ──────────────────────────────────────────────────────────
// The warning goes in BEFORE the final save, so it reaches the file. Items the
// listing misses still come in from the sitemap, and their own pages fill in
// the details (scripts/scrape-pages.mjs).
if (byId.size < grandTotal) {
  warnings.push(`Unique items scraped (${byId.size}) < Wowhead's grand total (${grandTotal}) — ${grandTotal - byId.size} item(s) remain unseen by the listing.`);
}
save(byId);
console.error('');
console.error(`Wowhead grand total : ${grandTotal}`);
console.error(`Unique items saved  : ${byId.size}${byId.size === grandTotal ? '  (complete match)' : ''}`);
console.error(`File                : ${jsonFile}`);
if (warnings.length > 0) {
  console.error('Warnings:');
  for (const w of warnings) console.error(`- ${w}`);
} else {
  console.error('No warnings: every chunk was verified against Wowhead\'s own applied-filter list and totals.');
}
