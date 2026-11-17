#!/usr/bin/env node
/**
 * Refuse a snapshot that looks broken, before it's committed (and released).
 *
 * Compares the new snapshot's counts with the previous snapshot's and checks
 * the run itself. Fails (exit 1) when:
 *   - items, item pages, drop tables, drop rows or NPCs with spawn points
 *     shrank by more than their allowance
 *   - pages were read but didn't parse (Wowhead changed its page layout)
 *   - too many page reads failed outright (the relay or the token is broken)
 * Shrinking is measured against the previous snapshot of the same schema; the
 * first schema 2 snapshot is only compared on what schema 1 had.
 *
 * Writes a Markdown summary to $GITHUB_STEP_SUMMARY when it's set.
 * Usage:  node scripts/check-snapshot.mjs <snapshot dir>
 * Env:    SNAPSHOT_CHECK=off skips the check (for a deliberate, known drop)
 */
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { FILES, readJson } = await import(pathToFileURL(join(root, 'dist', 'snapshot.js')));

const argv = process.argv.slice(2);
const dataAt = argv.indexOf('--data');
const dataDir = dataAt >= 0 ? argv.splice(dataAt, 2)[1] : join(root, 'data');
const dir = argv[0];
if (!dir) {
  console.error('usage: node scripts/check-snapshot.mjs <snapshot dir> [--data <scrape data dir>]');
  process.exit(1);
}
const manifest = readJson(join(dir, FILES.manifest));
const prev = readJson(join(dataDir, 'pages', 'prev-counts.json'));
if (!manifest?.counts) {
  console.error(`No manifest with counts in ${dir}.`);
  process.exit(1);
}
const now = manifest.counts;
const run = manifest.run ?? {};

/** Largest allowed drop, as a fraction of the previous value. */
const ALLOWANCE = { items: 0.02, itemPages: 0.03, dropTables: 0.03, dropRows: 0.1, npcsWithSpawns: 0.05, vendorTables: 0.1 };
const problems = [];
const lines = [];

for (const [key, allowed] of Object.entries(ALLOWANCE)) {
  const before = prev?.[key];
  const after = now[key];
  if (typeof before !== 'number' || typeof after !== 'number') continue;
  const change = before > 0 ? (after - before) / before : 0;
  const pct = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
  const bad = change < -allowed;
  lines.push(`| ${key} | ${before} | ${after} | ${pct} | ${bad ? '**too low**' : 'ok'} |`);
  if (bad) problems.push(`${key} fell from ${before} to ${after} (${pct}; allowed: -${allowed * 100}%)`);
}

const rate = (part, whole) => (whole > 0 ? part / whole : 0);
for (const [label, s] of [['item', run.items], ['NPC', run.npcs]]) {
  if (!s || !s.attempted) continue;
  const unparsed = rate(s.unparsed ?? 0, s.attempted);
  const failed = rate(s.failed ?? 0, s.attempted);
  lines.push(`| ${label} pages read | | ${s.ok + s.missing} of ${s.attempted} | ${s.failed} failed, ${s.unparsed ?? 0} unparsed | ${unparsed > 0.05 || failed > 0.25 ? '**bad**' : 'ok'} |`);
  if (unparsed > 0.05) problems.push(`${s.unparsed} of ${s.attempted} ${label} pages didn't parse: did Wowhead change its page layout?`);
  if (failed > 0.25) problems.push(`${s.failed} of ${s.attempted} ${label} pages couldn't be read: is the relay or the WAF token broken?`);
}
if (run.items?.ok > 100 && rate(run.items.withoutListviews ?? 0, run.items.ok) > 0.05) {
  problems.push(`${run.items.withoutListviews} of ${run.items.ok} item pages had no tables at all: did Wowhead change its page layout?`);
}

const off = process.env.SNAPSHOT_CHECK === 'off';
const summary = [
  `### Snapshot ${manifest.date}`,
  '',
  '| | before | now | change | |',
  '|---|---|---|---|---|',
  ...lines,
  '',
  `Carried over from earlier runs: ${run.itemPagesCarried ?? 0} item pages${run.oldestCarried ? ` (oldest from ${run.oldestCarried})` : ''}.`,
  '',
  problems.length
    ? `**${off ? 'Check skipped (SNAPSHOT_CHECK=off), but' : 'Not committed:'}**\n${problems.map((p) => `- ${p}`).join('\n')}`
    : 'All checks passed.',
  '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
if (problems.length && !off) {
  for (const p of problems) console.log(`::error::${p}`);
  process.exit(1);
}
