#!/usr/bin/env node
/**
 * Build the snapshot (schema 2, see src/snapshot.ts) from today's scrape and the
 * previous snapshot.
 *
 *   - items.jsonl from today's listing and sitemap (data/items.json)
 *   - item-pages.jsonl: today's page where one was read, otherwise the previous
 *     snapshot's (with its older date), so a page that failed today keeps
 *     yesterday's data instead of vanishing
 *   - npcs / objects / quests / spells / zones: everything the item pages point at,
 *     updated from today's rows and NPC pages
 *
 * Usage:  node scripts/build-snapshot.mjs --prev <dir> [--out <dir>]
 *         (--out defaults to --prev: the data repo's data/ folder is updated in place)
 * Also writes data/pages/prev-counts.json, the previous snapshot's counts, for
 * scripts/check-snapshot.mjs.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = (p) => pathToFileURL(join(root, 'dist', p));
const { FILES, LEGACY_FILES, ROW_FORMATS, SCHEMA, parseMoney, readJson, readJsonlSync, snapshotCounts, snapshotSchema, writeJsonl } =
  await import(dist('snapshot.js'));
const { LOOT_TARGET } = await import(dist('wowhead/pages.js'));
const { SLOT_NAMES } = await import(dist('present.js'));
const { QUALITY_NAMES } = await import(dist('wowhead/types.js'));

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prevDir = opt('--prev');
const outDir = opt('--out') ?? prevDir;
if (!outDir) {
  console.error('usage: node scripts/build-snapshot.mjs --prev <dir> [--out <dir>]');
  process.exit(1);
}
const dataDir = opt('--data') ?? join(root, 'data');
const pagesDir = join(dataDir, 'pages');
const log = (...a) => console.error(...a);

// ── Inputs ───────────────────────────────────────────────────────────────────
const listing = JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8'));
const run = readJson(join(pagesDir, 'run.json')) ?? {};
const areaNames = readJson(join(pagesDir, 'areas.json')) ?? {};
const freshItems = new Map(readJsonlSync(join(pagesDir, 'items.jsonl')).map((r) => [r.id, r]));
const freshNpcs = new Map(readJsonlSync(join(pagesDir, 'npcs.jsonl')).map((r) => [r.id, r]));

const prevCounts = prevDir ? snapshotCounts(prevDir) : undefined;
mkdirSync(pagesDir, { recursive: true });
writeFileSync(join(pagesDir, 'prev-counts.json'), JSON.stringify(prevCounts ?? null, null, 1));

const prev = { pages: new Map(), npcs: new Map(), objects: new Map(), quests: new Map(), spells: new Map(), zones: {} };
if (prevDir && snapshotSchema(prevDir) >= 2) {
  for (const [key, file] of [['pages', FILES.pages], ['npcs', FILES.npcs], ['objects', FILES.objects], ['quests', FILES.quests], ['spells', FILES.spells]]) {
    for (const r of readJsonlSync(join(prevDir, file))) prev[key].set(r.id, r);
  }
  prev.zones = readJson(join(prevDir, FILES.zones)) ?? {};
}

// ── items.jsonl ──────────────────────────────────────────────────────────────
const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const items = [];
for (const it of listing.items ?? []) {
  if (!Number.isInteger(it.id) || it.id <= 0) continue;
  const fromSitemap = it.nameSource === 'sitemap-slug';
  const rec = {
    id: it.id,
    name: it.name,
    slug: it.slug,
    origin: fromSitemap ? 'sitemap' : 'listing',
    quality: it.quality,
    itemLevel: int(it.itemLevel),
    requiredLevel: int(it.requiredLevel),
    slot: it.slot,
    dps: it.dps,
    speed: it.speed,
    damageMin: it.damageMin,
    damageMax: it.damageMax,
    armor: it.armor,
    stats: it.stats,
    obtainedBy: it.obtainedBy,
    from: it.from,
    zone: it.zone,
    sellCopper: parseMoney(it.sellPrice),
  };
  for (const k of Object.keys(rec)) if (rec[k] === undefined || rec[k] === '') delete rec[k];
  items.push(rec);
}
const itemIds = new Set(items.map((i) => i.id));

// ── item-pages.jsonl: today's page, else the previous one ───────────────────
const pages = new Map();
let carried = 0;
let oldest;
for (const id of itemIds) {
  const fresh = freshItems.get(id);
  if (fresh) {
    const rec = { id, fetchedAt: fresh.fetchedAt };
    if (fresh.missing) rec.missing = true;
    else {
      const p = fresh.page;
      if (p.self && Object.keys(p.self).length) {
        rec.self = { ...p.self };
        if (rec.self.slotType && SLOT_NAMES[rec.self.slotType]) rec.self.slot = SLOT_NAMES[rec.self.slotType];
        if (typeof rec.self.quality === 'number') rec.self.quality = QUALITY_NAMES[rec.self.quality] ?? rec.self.quality;
        delete rec.self.slotType;
      }
      Object.assign(rec, p.sources);
    }
    pages.set(id, rec);
  } else if (prev.pages.has(id)) {
    const rec = prev.pages.get(id);
    pages.set(id, rec);
    carried++;
    if (!oldest || rec.fetchedAt < oldest) oldest = rec.fetchedAt;
  }
}

// ── Referenced entities ──────────────────────────────────────────────────────
const refs = { npc: new Set(), object: new Set(), zone: new Set(), quest: new Set(), spell: new Set() };
for (const rec of pages.values()) {
  for (const [key, target] of Object.entries(LOOT_TARGET)) {
    if (target === 'item') continue;
    for (const row of rec[key] ?? []) refs[target].add(row[0]);
  }
  for (const row of rec.soldBy ?? []) refs.npc.add(row[0]);
  for (const q of rec.rewardFrom ?? []) refs.quest.add(q);
  for (const s of rec.createdBy ?? []) refs.spell.add(s);
}

// NPCs: previous record <- today's rows on item pages <- today's NPC page.
const merge = (target, info) => {
  for (const [k, v] of Object.entries(info)) if (v !== undefined) target[k] = v;
  return target;
};
const npcs = new Map();
for (const id of refs.npc) {
  const base = prev.npcs.get(id);
  npcs.set(id, base ? { ...base } : { id });
}
const objects = new Map();
const quests = new Map();
const spells = new Map();
for (const [map, prevMap, ids] of [[objects, prev.objects, refs.object], [quests, prev.quests, refs.quest], [spells, prev.spells, refs.spell]]) {
  for (const id of ids) map.set(id, { ...(prevMap.get(id) ?? { id }) });
}
const zoneInfo = {};
for (const [k, v] of Object.entries(prev.zones)) zoneInfo[k] = { ...v };

for (const fresh of freshItems.values()) {
  const p = fresh.page;
  if (!p || !itemIds.has(fresh.id)) continue;
  for (const n of p.npcs) if (npcs.has(n.id)) merge(npcs.get(n.id), n);
  for (const o of p.objects) if (objects.has(o.id)) merge(objects.get(o.id), o);
  for (const q of p.quests) if (quests.has(q.id)) merge(quests.get(q.id), q);
  for (const s of p.spells) if (spells.has(s.id)) merge(spells.get(s.id), s);
  for (const [zid, name] of Object.entries(p.zoneNames ?? {})) (zoneInfo[zid] ??= {}).name ??= name;
}
for (const fresh of freshNpcs.values()) {
  const npc = npcs.get(fresh.id);
  if (!npc) continue;
  npc.pageFetchedAt = fresh.fetchedAt;
  if (fresh.missing) continue;
  merge(npc, fresh.page.info);
  if (fresh.page.spawns) npc.spawns = fresh.page.spawns;
  else delete npc.spawns;
  for (const [area, uiMapId] of Object.entries(fresh.page.areaMaps ?? {})) (zoneInfo[area] ??= {}).uiMapId = uiMapId;
}

// Zones: every area an NPC, object or fishing table points at, named from Wowhead's table.
for (const n of npcs.values()) for (const z of n.zones ?? []) refs.zone.add(z);
for (const o of objects.values()) for (const z of o.zones ?? []) refs.zone.add(z);
const zones = {};
for (const z of [...refs.zone].sort((a, b) => a - b)) {
  const info = { ...(zoneInfo[z] ?? {}) };
  if (areaNames[z]) info.name = areaNames[z];
  if (info.name || info.uiMapId) zones[z] = info;
}
// Keep the area -> uiMapId pairs NPC pages taught us even for areas no row names.
for (const [z, info] of Object.entries(zoneInfo)) if (!zones[z] && info.uiMapId) zones[z] = { ...info, ...(areaNames[z] ? { name: areaNames[z] } : {}) };

// ── Counts and manifest ──────────────────────────────────────────────────────
const pageList = [...pages.values()];
const counts = {
  items: items.length,
  itemPages: pageList.filter((p) => !p.missing).length,
  dropTables: pageList.filter((p) => p.droppedBy?.length).length,
  dropRows: pageList.reduce((s, p) => s + (p.droppedBy?.length ?? 0), 0),
  vendorTables: pageList.filter((p) => p.soldBy?.length).length,
  sourced: pageList.filter((p) => Object.keys(p).some((k) => !['id', 'fetchedAt', 'missing', 'self', 'truncated'].includes(k))).length,
  npcs: npcs.size,
  npcsWithSpawns: [...npcs.values()].filter((n) => n.spawns).length,
  objects: objects.size,
  quests: quests.size,
  spells: spells.size,
  zones: Object.keys(zones).length,
};

const manifest = {
  schema: SCHEMA,
  date: run.date ?? new Date().toISOString().slice(0, 10),
  scrapedAt: new Date().toISOString(),
  source: 'https://www.wowhead.com/forever/',
  wowhead: {
    listingTotal: listing.totalOnWowhead,
    listed: items.filter((i) => i.origin === 'listing').length,
    sitemapOnly: items.filter((i) => i.origin === 'sitemap').length,
    sitemapItems: listing.sitemapItems,
  },
  counts,
  run: {
    ...run,
    itemPagesCarried: carried,
    oldestCarried: oldest,
  },
  files: FILES,
  formats: ROW_FORMATS,
  warnings: (listing.warnings ?? []).slice(0, 200),
};

// ── Write ────────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
writeJsonl(join(outDir, FILES.items), items);
writeJsonl(join(outDir, FILES.pages), pageList);
writeJsonl(join(outDir, FILES.npcs), npcs.values());
writeJsonl(join(outDir, FILES.objects), objects.values());
writeJsonl(join(outDir, FILES.quests), quests.values());
writeJsonl(join(outDir, FILES.spells), spells.values());
writeFileSync(join(outDir, FILES.zones), JSON.stringify(zones, null, 1) + '\n');
writeFileSync(join(outDir, FILES.manifest), JSON.stringify(manifest, null, 1) + '\n');
for (const f of LEGACY_FILES) if (existsSync(join(outDir, f))) rmSync(join(outDir, f));

log(`Snapshot written to ${outDir}:`);
for (const [k, v] of Object.entries(counts)) log(`  ${k.padEnd(15)} ${v}${prevCounts?.[k] !== undefined ? `  (was ${prevCounts[k]})` : ''}`);
log(`  carried over    ${carried} item pages${oldest ? ` (oldest from ${oldest})` : ''}`);
