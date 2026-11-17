// build-snapshot + check-snapshot end to end, on a tiny scrape in a temp folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const readJsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const node = (script, args) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });

/** A previous snapshot (schema 2) and today's scrape: item 1 failed today, item 2 is new. */
function setUp({ prevDropTables } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  const data = join(base, 'scrape');
  const prev = join(base, 'repo');
  mkdirSync(join(data, 'pages'), { recursive: true });
  mkdirSync(prev, { recursive: true });

  writeFileSync(join(data, 'items.json'), JSON.stringify({
    totalOnWowhead: 3,
    sitemapItems: 3,
    warnings: [],
    items: [
      { id: 1, name: 'Boar Tusk', quality: 'Poor', itemLevel: '5', obtainedBy: 'Drop', sellPrice: '1s 5c', slug: 'boar-tusk' },
      { id: 2, name: 'Courser Eye', slug: 'courser-eye', nameSource: 'sitemap-slug' },
      { id: 3, name: 'Plain Thing', quality: 'Common' },
    ],
  }));
  writeFileSync(join(data, 'pages', 'items.jsonl'), jsonl([
    { id: 2, fetchedAt: '2026-11-18', page: {
      id: 2,
      self: { name: 'Courser Eye', quality: 1, icon: 'inv_misc_eye_01', itemLevel: 22, slotType: 0 },
      sources: { droppedBy: [[4018, 85.5, 10000]] },
      npcs: [{ id: 4018, name: 'Antlered Courser', minLevel: 22, maxLevel: 23, zones: [406] }],
      objects: [], quests: [], spells: [], zoneNames: {}, listviews: { 'dropped-by': 1, comments: 0 },
    } },
    { id: 3, fetchedAt: '2026-11-18', missing: true },
  ]));
  writeFileSync(join(data, 'pages', 'npcs.jsonl'), jsonl([
    { id: 4018, fetchedAt: '2026-11-18', page: { id: 4018, info: { id: 4018, name: 'Antlered Courser', family: 1 }, spawns: { 1442: [[40, 50]] }, areaMaps: { 406: 1442 } } },
  ]));
  writeFileSync(join(data, 'pages', 'run.json'), JSON.stringify({
    date: '2026-11-18',
    items: { attempted: 10, ok: 8, missing: 1, failed: 1, unparsed: 0, failedIds: [1], withoutListviews: 0 },
    npcs: { attempted: 1, ok: 1, missing: 0, failed: 0, unparsed: 0, failedIds: [] },
  }));
  writeFileSync(join(data, 'pages', 'areas.json'), JSON.stringify({ 12: 'Elwynn Forest', 406: 'Stonetalon Mountains' }));

  writeFileSync(join(prev, 'manifest.json'), JSON.stringify({
    schema: 2,
    counts: { items: 3, itemPages: 1, dropTables: prevDropTables ?? 1, dropRows: 1, npcsWithSpawns: 1 },
  }));
  writeFileSync(join(prev, 'item-pages.jsonl'), jsonl([{ id: 1, fetchedAt: '2026-11-17', droppedBy: [[113, 30.1, 500]] }]));
  writeFileSync(join(prev, 'npcs.jsonl'), jsonl([{ id: 113, name: 'Stonetusk Boar', zones: [12], spawns: { 1429: [[1, 2]] }, pageFetchedAt: '2026-11-17' }]));
  writeFileSync(join(prev, 'items.csv'), 'legacy');
  return { data, prev };
}

test('a page that failed today keeps the previous snapshot data; new pages and NPCs come in', () => {
  const { data, prev } = setUp();
  const built = node('build-snapshot.mjs', ['--prev', prev, '--data', data]);
  assert.equal(built.status, 0, built.stderr);

  const pages = readJsonl(join(prev, 'item-pages.jsonl'));
  assert.deepEqual(pages.map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(pages[0], { id: 1, fetchedAt: '2026-11-17', droppedBy: [[113, 30.1, 500]] }, 'carried over');
  assert.deepEqual(pages[1].self, { name: 'Courser Eye', quality: 'Common', icon: 'inv_misc_eye_01', itemLevel: 22 });
  assert.deepEqual(pages[1].droppedBy, [[4018, 85.5, 10000]]);
  assert.deepEqual(pages[2], { id: 3, fetchedAt: '2026-11-18', missing: true });

  const items = readJsonl(join(prev, 'items.jsonl'));
  assert.deepEqual(items[0], { id: 1, name: 'Boar Tusk', slug: 'boar-tusk', origin: 'listing', quality: 'Poor', itemLevel: 5, obtainedBy: 'Drop', sellCopper: 105 });
  assert.equal(items[1].origin, 'sitemap');

  const npcs = readJsonl(join(prev, 'npcs.jsonl'));
  assert.deepEqual(npcs.map((n) => n.id), [113, 4018]);
  assert.deepEqual(npcs[1], { id: 4018, name: 'Antlered Courser', minLevel: 22, maxLevel: 23, zones: [406], pageFetchedAt: '2026-11-18', family: 1, spawns: { 1442: [[40, 50]] } });
  assert.deepEqual(JSON.parse(readFileSync(join(prev, 'zones.json'), 'utf8')), {
    12: { name: 'Elwynn Forest' },
    406: { uiMapId: 1442, name: 'Stonetalon Mountains' },
  });

  const manifest = JSON.parse(readFileSync(join(prev, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.counts.dropTables, 2);
  assert.equal(manifest.counts.npcsWithSpawns, 2);
  assert.equal(manifest.run.itemPagesCarried, 1);
  assert.equal(existsSync(join(prev, 'items.csv')), false, 'schema 1 files are removed');

  const checked = node('check-snapshot.mjs', [prev, '--data', data]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /All checks passed/);
});

test('the check refuses a snapshot that lost drop tables', () => {
  const { data, prev } = setUp({ prevDropTables: 50 });
  assert.equal(node('build-snapshot.mjs', ['--prev', prev, '--data', data]).status, 0);
  const checked = node('check-snapshot.mjs', [prev, '--data', data]);
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /dropTables fell from 50 to 2/);
});

test('the check refuses a run whose pages stopped parsing', () => {
  const { data, prev } = setUp();
  const runFile = join(data, 'pages', 'run.json');
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  run.items = { attempted: 100, ok: 10, missing: 0, failed: 90, unparsed: 90, failedIds: [] };
  writeFileSync(runFile, JSON.stringify(run));
  assert.equal(node('build-snapshot.mjs', ['--prev', prev, '--data', data]).status, 0);
  const checked = node('check-snapshot.mjs', [prev, '--data', data]);
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /didn't parse/);
});
