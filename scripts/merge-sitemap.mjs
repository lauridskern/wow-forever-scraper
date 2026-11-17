#!/usr/bin/env node
/**
 * Complete data/items.json with the official Forever item sitemap.
 *
 * Wowhead publishes a Forever-scoped item sitemap — one page, 25,573 URLs,
 * each carrying the item name in its slug. The listing scrape (scrape-items.mjs)
 * gets rich rows (stats, slot, sources) but Wowhead's own listing UI hides some
 * items and caps pages, so the sitemap is the completeness backstop:
 *
 *   - ids already scraped keep their listing data and gain the slug
 *   - ids the listing never showed become thin entries {id, name, url} named
 *     from the slug (title-cased; run scripts/enrich-items.mjs for full stats)
 *
 * No WAF token is needed: sitemaps sit outside the challenge.
 *
 * Usage:  node scripts/merge-sitemap.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'data');
const jsonFile = join(outDir, 'items.json');

const { loadEnv } = await import(pathToFileURL(join(root, 'dist', 'config.js')));
const { WowheadClient } = await import(pathToFileURL(join(root, 'dist', 'wowhead', 'client.js')));
const { presentListingRow } = await import(pathToFileURL(join(root, 'dist', 'present.js')));

const env = loadEnv();
const client = new WowheadClient(env);
const globals = await client.globalNames();
const ctx = { globals, names: new Map(), pageUrl: (p, id) => client.pageUrl(p, id) };

// ── 1. Fetch the sitemap ────────────────────────────────────────────────────
console.error('Fetching https://www.wowhead.com/forever/sitemap/item?page=1 ...');
const res = await fetch('https://www.wowhead.com/forever/sitemap/item?page=1', {
  headers: {
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'upgrade-insecure-requests': '1',
  },
  signal: AbortSignal.timeout(120_000),
});
if (!res.ok) throw new Error(`Sitemap fetch failed: HTTP ${res.status}`);
const xml = await res.text();
const entries = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
console.error(`Sitemap has ${entries.length} item URLs.`);

const slugOf = (url) => /\/item=(\d+)\/(.+)$/.exec(url);
const sitemap = new Map();
for (const url of entries) {
  const m = slugOf(url);
  if (!m) continue;
  sitemap.set(Number(m[1]), m[2]);
}
console.error(`Parsed ${sitemap.size} ids with slugs.`);

/** "worn-shortsword" -> "Worn Shortsword"; numbers and case kept as-is. */
function slugToName(slug) {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ── 2. Merge with the listing scrape ───────────────────────────────────────
const current = JSON.parse(readFileSync(jsonFile, 'utf8'));
const scraped = current.items ?? [];
console.error(`Existing scrape: ${scraped.length} items (wowhead listing total: ${current.totalOnWowhead}).`);

const byId = new Map(scraped.map((it) => [it.id, it]));
for (const [id, it] of byId) {
  const slug = sitemap.get(id);
  if (slug !== undefined) it.slug = slug;
}

const thin = [];
for (const [id, slug] of sitemap) {
  if (byId.has(id)) continue;
  thin.push({ id, name: slugToName(slug), slug, url: client.pageUrl('item', id), nameSource: 'sitemap-slug' });
}
for (const t of thin) byId.set(t.id, t);

// ── 3. Save ────────────────────────────────────────────────────────────
const payload = {
  scrapedAt: new Date().toISOString(),
  totalOnWowhead: current.totalOnWowhead,
  sitemapItems: sitemap.size,
  itemsWithListingData: scraped.length,
  itemsNamedFromSitemapOnly: thin.length,
  uniqueItems: byId.size,
  warnings: current.warnings ?? [],
  items: [...byId.values()],
};
mkdirSync(outDir, { recursive: true });
writeFileSync(jsonFile, JSON.stringify(payload, null, 1));


console.error('');
console.error(`Forever sitemap items        : ${sitemap.size}`);
console.error(`Items with full listing data : ${scraped.length}`);
console.error(`Items named from slug only   : ${thin.length}`);
console.error(`Unique items in dataset      : ${byId.size}`);
console.error(`File                         : ${jsonFile}`);
console.error('');
console.error('Thin entries carry id + name + url only (Wowhead hides them from every listing).');
console.error('scripts/scrape-pages.mjs reads their pages and fills in the details.');
