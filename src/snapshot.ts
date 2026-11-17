/**
 * The snapshot format in wow-forever-data (schema 2), and the helpers the
 * scripts share to read and write it.
 *
 * data/
 *   manifest.json        schema, date, counts, this run's stats and warnings, row formats
 *   items.jsonl          one item per line, from Wowhead's item listing (or only the sitemap):
 *                        name, quality, levels, slot, stats, sell price, how it's obtained
 *   item-pages.jsonl     one item per line, from its own page: `self` (name, quality, icon,
 *                        item level, prices) and every table that says where it comes from
 *                        (dropped by, sold by, skinned from, mined from, ...), with the date read
 *   npcs.jsonl           every NPC those tables mention: level, rank, type, zones, spawn points
 *   objects.jsonl        chests, herbs, veins and other objects those tables mention
 *   quests.jsonl         quests that reward an item
 *   spells.jsonl         recipes that create an item
 *   zones.json           area id -> { name, uiMapId }
 *
 * Every .jsonl file is sorted by id with one record per line, so a day's
 * changes show up as a readable diff of the lines that changed.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export const SCHEMA = 2;

export const ROW_FORMATS = {
  loot: '[id, chance %, samples, avg stack (when not 1)] (chance: 3 significant digits; samples over 100: 2)',
  vendor: '[npcId, copper, stock (-1 = unlimited), stack, {currencies, items} (extra cost, when any)]',
  spawns: '{ uiMapId: [[x, y], ...] } in map percent',
  lootTargets: {
    droppedBy: 'npc',
    pickpocketedFrom: 'npc',
    skinnedFrom: 'npc',
    containedInObject: 'object',
    minedFrom: 'object',
    gatheredFrom: 'object',
    fishedIn: 'zone',
    containedInItem: 'item',
    disenchant: 'item',
  },
} as const;

export const FILES = {
  manifest: 'manifest.json',
  items: 'items.jsonl',
  pages: 'item-pages.jsonl',
  npcs: 'npcs.jsonl',
  objects: 'objects.jsonl',
  quests: 'quests.jsonl',
  spells: 'spells.jsonl',
  zones: 'zones.json',
} as const;

/** Files of the first format (schema 1), removed when a schema 2 snapshot is written. */
export const LEGACY_FILES = ['items.json', 'items.csv', 'item-drops.jsonl'] as const;

export interface Counts {
  items: number;
  /** Items whose page was read at least once (fresh or carried over). */
  itemPages?: number;
  dropTables: number;
  dropRows?: number;
  vendorTables?: number;
  /** Items with any source table at all. */
  sourced?: number;
  npcs?: number;
  npcsWithSpawns?: number;
  objects?: number;
}

/** One JSON record per line, sorted by `id`. */
export function writeJsonl(file: string, records: Iterable<{ id: number }>): number {
  const list = [...records].sort((a, b) => a.id - b.id);
  writeFileSync(file, list.map((r) => JSON.stringify(r)).join('\n') + (list.length ? '\n' : ''));
  return list.length;
}

export function readJsonlSync<T = Record<string, unknown>>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a torn last line from an interrupted run */
    }
  }
  return out;
}

export async function* readJsonl<T = Record<string, unknown>>(file: string): AsyncGenerator<T> {
  if (!existsSync(file)) return;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as T;
    } catch {
      /* torn line */
    }
  }
}

export function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Which format a snapshot directory holds: 2, 1 (items.json) or 0 (none). */
export function snapshotSchema(dir: string): number {
  const manifest = readJson<{ schema?: number }>(join(dir, FILES.manifest));
  if (manifest?.schema) return manifest.schema;
  return existsSync(join(dir, 'items.json')) ? 1 : 0;
}

/** The counts of whatever snapshot a directory holds, for the regression check. */
export function snapshotCounts(dir: string): Counts | undefined {
  const schema = snapshotSchema(dir);
  if (schema >= 2) return readJson<{ counts?: Counts }>(join(dir, FILES.manifest))?.counts;
  if (schema === 1) {
    const old = readJson<{ items?: Array<{ droppedBy?: unknown[] }> }>(join(dir, 'items.json'));
    const items = old?.items ?? [];
    return { items: items.length, dropTables: items.filter((i) => i.droppedBy?.length).length };
  }
  return undefined;
}

/** "1g 2s 3c" -> 10203. */
export function parseMoney(text: unknown): number | undefined {
  if (typeof text === 'number') return text > 0 ? Math.round(text) : undefined;
  if (typeof text !== 'string') return undefined;
  let total = 0;
  for (const m of text.matchAll(/(\d+)\s*([gsc])/g)) {
    total += Number(m[1]) * (m[2] === 'g' ? 10000 : m[2] === 's' ? 100 : 1);
  }
  return total || undefined;
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

/** Whole days between two YYYY-MM-DD dates (or ISO timestamps). */
export function daysBetween(from: string | undefined, to: string): number {
  if (!from) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000);
}
