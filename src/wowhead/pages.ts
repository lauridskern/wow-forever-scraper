/**
 * Item and NPC pages, reduced to the data the snapshot keeps.
 *
 * An item page carries one Listview per way to get the item (dropped by, sold
 * by, skinned from, mined from, quest reward, ...). Every row of those tables
 * also describes the NPC, object, quest or spell it points at, so those name
 * tables come for free. An NPC page adds what no item page has: its spawn
 * points (`g_mapperData`, already keyed by the game's uiMapID) and its family.
 *
 * Rows are stored as small arrays so a snapshot of every table stays a few MB:
 *   LootRow   [id, chance %, samples, avg stack?]  (stack only when not 1)
 *   VendorRow [npcId, copper, stock (-1 = unlimited), stack, extra cost?]
 * Chances are rounded to 3 significant digits and sample counts above 100 to 2,
 * so a day of new kills on Wowhead doesn't rewrite every line of the snapshot.
 */
import { decodeEntities, extractBalanced, lenientJson, parseListviews, type Listview } from './parse.js';

export type LootRow = [number, number, number] | [number, number, number, number];
export type VendorRow = [number, number, number, number] | [number, number, number, number, VendorExtra];
export interface VendorExtra {
  currencies?: unknown[];
  items?: unknown[];
}

/** Item-page tables that say where an item comes from, by snapshot key. */
export const LOOT_TABLES = {
  'dropped-by': 'droppedBy',
  'pick-pocketed-from': 'pickpocketedFrom',
  'skinned-from': 'skinnedFrom',
  'contained-in-object': 'containedInObject',
  'mined-from-object': 'minedFrom',
  'gathered-from-object': 'gatheredFrom',
  'fished-in': 'fishedIn',
  'contained-in-item': 'containedInItem',
  disenchanting: 'disenchant',
} as const;
export type LootKey = (typeof LOOT_TABLES)[keyof typeof LOOT_TABLES];

/** What each loot table's row ids point at. */
export const LOOT_TARGET: Record<LootKey, 'npc' | 'object' | 'zone' | 'item'> = {
  droppedBy: 'npc',
  pickpocketedFrom: 'npc',
  skinnedFrom: 'npc',
  containedInObject: 'object',
  minedFrom: 'object',
  gatheredFrom: 'object',
  fishedIn: 'zone',
  containedInItem: 'item',
  disenchant: 'item',
};

export type ItemSources = Partial<Record<LootKey, LootRow[]>> & {
  soldBy?: VendorRow[];
  rewardFrom?: number[];
  createdBy?: number[];
  /** Tables Wowhead cut short: key -> how many rows it says exist. */
  truncated?: Record<string, number>;
};

export interface NpcInfo {
  id: number;
  name?: string;
  tag?: string;
  minLevel?: number;
  maxLevel?: number;
  /** Wowhead's: 0 normal, 1 elite, 2 rare elite, 3 boss, 4 rare. */
  classification?: number;
  /** Creature type: 1 beast, 7 humanoid, ... */
  type?: number;
  family?: number;
  /** [Alliance, Horde]: -1 hostile, 0 neutral, 1 friendly. */
  react?: [number | null, number | null];
  boss?: 1;
  zones?: number[];
}

export interface ObjectInfo {
  id: number;
  name?: string;
  /** -3 herb, -4 mineral vein, -5 container, ... */
  type?: number;
  skill?: number;
  zones?: number[];
}

export interface QuestInfo {
  id: number;
  name?: string;
  level?: number;
  reqLevel?: number;
  /** 1 Alliance, 2 Horde, 3 both. */
  side?: number;
  category?: number;
}

export interface SpellInfo {
  id: number;
  name?: string;
  skill?: number[];
  learnedAt?: number;
  reagents?: Array<[number, number]>;
  creates?: number[];
}

export interface ItemSelf {
  name?: string;
  quality?: number;
  icon?: string;
  itemLevel?: number;
  reqLevel?: number;
  /** Inventory type (Wowhead's slotbak): 1 head, 13 one-hand, 17 two-hand, ... */
  slotType?: number;
  sellCopper?: number;
  buyCopper?: number;
  /** Wowhead's average AH buyout, in copper. */
  avgBuyout?: number;
}

export interface ItemPage {
  id: number;
  self: ItemSelf;
  sources: ItemSources;
  npcs: NpcInfo[];
  objects: ObjectInfo[];
  quests: QuestInfo[];
  spells: SpellInfo[];
  /** Zone names seen in rows (fished-in), id -> name. */
  zoneNames: Record<string, string>;
  /** Every Listview id on the page with its row count, for monitoring layout changes. */
  listviews: Record<string, number>;
}

export interface NpcPage {
  id: number;
  info: NpcInfo;
  /** uiMapID -> [[x, y], ...] in map percent, one decimal. */
  spawns?: Record<string, Array<[number, number]>>;
  /** Wowhead area id -> uiMapID, from the same map data. */
  areaMaps: Record<string, number>;
}

// ── Rounding ─────────────────────────────────────────────

/** Percent with 3 significant digits: 57.78 -> 57.8, 0.01234 -> 0.0123. */
export function roundChance(count: number, outof: number): number {
  if (!(count > 0) || !(outof > 0)) return 0;
  const pct = (count / outof) * 100;
  const scale = 10 ** (3 - Math.ceil(Math.log10(pct + 1e-12)));
  return Math.round(pct * scale) / scale;
}

/** Sample counts above 100 to 2 significant digits: 41880 -> 42000. */
export function roundSamples(n: number): number {
  if (!(n > 0)) return 0;
  if (n < 100) return Math.round(n);
  const scale = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / scale) * scale;
}

/** Wowhead's stack spread, "{1: 50.27,2: 49.73}" -> 1.5. Undefined when always 1. */
export function averageStack(pctstack: unknown, stack?: unknown): number | undefined {
  let sum = 0;
  let weight = 0;
  if (typeof pctstack === 'string') {
    for (const m of pctstack.matchAll(/(\d+)\s*:\s*([\d.]+)/g)) {
      const k = Number(m[1]);
      const p = Number(m[2]);
      if (k > 0 && p > 0) {
        sum += k * p;
        weight += p;
      }
    }
  }
  let avg = weight > 0 ? sum / weight : undefined;
  // No spread but a fixed range, e.g. stack: [2, 2].
  if (avg === undefined && Array.isArray(stack) && typeof stack[0] === 'number') {
    const lo = stack[0];
    const hi = typeof stack[1] === 'number' ? stack[1] : lo;
    if (lo > 0 && hi >= lo) avg = (lo + hi) / 2;
  }
  if (avg === undefined) return undefined;
  const rounded = Math.round(avg * 100) / 100;
  return Math.abs(rounded - 1) < 0.005 ? undefined : rounded;
}

// ── Small readers ────────────────────────────────────────

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const posInt = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? Math.round(n) : undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const zoneList = (v: unknown): number[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const ids = [...new Set(v.filter((z): z is number => typeof z === 'number' && z > 0))].sort((a, b) => a - b);
  return ids.length ? ids : undefined;
};
const rowName = (row: Record<string, unknown>): string | undefined => {
  const name = str(row['name']) ?? str(row['displayName']);
  return name ? decodeEntities(name) : undefined;
};

function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

function lootRow(row: Record<string, unknown>): LootRow | undefined {
  const id = posInt(row['id']);
  const count = num(row['count']);
  const outof = num(row['outof']);
  if (id === undefined || count === undefined || outof === undefined || !(outof > 0)) return undefined;
  const chance = roundChance(count, outof);
  const stack = averageStack(row['pctstack'], row['stack']);
  return stack === undefined ? [id, chance, roundSamples(outof)] : [id, chance, roundSamples(outof), stack];
}

/** Vendor `cost` is [[copper, currencies?, items?]] (or [copper, ...] on some tables). */
function vendorRow(row: Record<string, unknown>): VendorRow | undefined {
  const id = posInt(row['id']);
  if (id === undefined) return undefined;
  const cost = Array.isArray(row['cost']) ? (row['cost'] as unknown[]) : [];
  const first = Array.isArray(cost[0]) ? (cost[0] as unknown[]) : cost;
  const copper = num(first[0]) ?? 0;
  const currencies = Array.isArray(first[1]) && first[1].length ? (first[1] as unknown[]) : undefined;
  const items = Array.isArray(first[2]) && first[2].length ? (first[2] as unknown[]) : undefined;
  const stock = num(row['stock']) ?? num(row['avail']) ?? -1;
  const stackRaw = Array.isArray(row['stack']) ? row['stack'][0] : row['stack'];
  const stack = posInt(stackRaw) ?? 1;
  const base: [number, number, number, number] = [id, Math.round(copper), Math.round(stock), stack];
  return currencies || items ? [...base, compact({ currencies, items })] : base;
}

function npcInfo(row: Record<string, unknown>): NpcInfo | undefined {
  const id = posInt(row['id']);
  if (id === undefined) return undefined;
  const react = Array.isArray(row['react'])
    ? ([num(row['react'][0]) ?? null, num(row['react'][1]) ?? null] as [number | null, number | null])
    : undefined;
  return compact({
    id,
    name: rowName(row),
    tag: str(row['tag']),
    minLevel: num(row['minlevel']),
    maxLevel: num(row['maxlevel']),
    classification: num(row['classification']),
    type: num(row['type']),
    family: posInt(row['family']),
    react,
    boss: row['boss'] ? (1 as const) : undefined,
    zones: zoneList(row['location']),
  });
}

function objectInfo(row: Record<string, unknown>): ObjectInfo | undefined {
  const id = posInt(row['id']);
  if (id === undefined) return undefined;
  const skill = Array.isArray(row['skill']) ? num(row['skill'][0]) : num(row['skill']);
  return compact({ id, name: rowName(row), type: num(row['type']), skill, zones: zoneList(row['location']) });
}

function questInfo(row: Record<string, unknown>): QuestInfo | undefined {
  const id = posInt(row['id']);
  if (id === undefined) return undefined;
  return compact({
    id,
    name: rowName(row),
    level: num(row['level']),
    reqLevel: num(row['reqlevel']),
    side: num(row['side']),
    category: num(row['category']),
  });
}

function spellInfo(row: Record<string, unknown>): SpellInfo | undefined {
  const id = posInt(row['id']);
  if (id === undefined) return undefined;
  const skill = Array.isArray(row['skill']) ? row['skill'].filter((s): s is number => typeof s === 'number') : undefined;
  const reagents = Array.isArray(row['reagents'])
    ? (row['reagents'] as unknown[])
        .filter((r): r is [number, number] => Array.isArray(r) && typeof r[0] === 'number')
        .map((r) => [r[0], num(r[1]) ?? 1] as [number, number])
    : undefined;
  const creates = Array.isArray(row['creates']) ? row['creates'].filter((x): x is number => typeof x === 'number') : undefined;
  return compact({
    id,
    name: rowName(row),
    skill: skill?.length ? skill : undefined,
    learnedAt: num(row['learnedat']),
    reagents: reagents?.length ? reagents : undefined,
    creates: creates?.length ? creates : undefined,
  });
}

// ── Page-level readers ───────────────────────────────────

/** `g_pageInfo = {type: 3, typeId: 159, ...}`: which entity a page is about. */
export function pageIdentity(html: string): { type: number; id: number } | undefined {
  const m = /g_pageInfo\s*=\s*\{[^}]*?\btype\s*:\s*(\d+)[^}]*?\btypeId\s*:\s*(\d+)/.exec(html);
  return m ? { type: Number(m[1]), id: Number(m[2]) } : undefined;
}

/** The `WH.Gatherer.addData(type, env, {id: {...}})` record of one entity. */
export function gathererRecord(html: string, typeId: number, id: number): Record<string, unknown> | undefined {
  const re = new RegExp(`Gatherer\\.addData\\(\\s*${typeId}\\s*,\\s*\\d+\\s*,\\s*`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = extractBalanced(html, m.index + m[0].length);
    const parsed = text ? lenientJson(text) : undefined;
    if (parsed && typeof parsed === 'object') {
      const rec = (parsed as Record<string, unknown>)[String(id)];
      if (rec && typeof rec === 'object') return rec as Record<string, unknown>;
    }
  }
  return undefined;
}

/** `$.extend(g_npcs[118], {...})`: the NPC's own row. */
function extendRecord(html: string, table: string, id: number): Record<string, unknown> | undefined {
  const re = new RegExp(`\\$\\.extend\\(\\s*${table}\\[${id}\\]\\s*,\\s*`);
  const m = re.exec(html);
  if (!m) return undefined;
  const text = extractBalanced(html, m.index + m[0].length);
  const parsed = text ? lenientJson(text) : undefined;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
}

/** `g_mapperData = {areaId: [{count, coords: [[x, y]], uiMapId, uiMapName}]}`. */
export function parseMapperData(html: string): Record<string, Array<Record<string, unknown>>> | undefined {
  const m = /g_mapperData\s*=\s*/.exec(html);
  if (!m) return undefined;
  const text = extractBalanced(html, m.index + m[0].length);
  const parsed = text ? lenientJson(text) : undefined;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, Array<Record<string, unknown>>>) : undefined;
}

/** "Item Level <!--ilvl-->20" in the item's own tooltip (`g_items[id].tooltip_enus`). */
function ownItemLevel(html: string, id: number): number | undefined {
  const at = html.indexOf(`g_items[${id}].tooltip_enus`);
  if (at < 0) return undefined;
  const m = /Item Level\s*(?:<!--ilvl-->)?\s*(\d+)/.exec(html.slice(at, at + 4000));
  return m ? posInt(Number(m[1])) : undefined;
}

function listviewCounts(lvs: Listview[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const lv of lvs) out[lv.id] = lv.rows.length;
  return out;
}

/** Parse an item page. Undefined when the page isn't this item's (Wowhead's soft 404). */
export function parseItemPage(html: string, id: number): ItemPage | undefined {
  const who = pageIdentity(html);
  if (!who || who.type !== 3 || who.id !== id) return undefined;

  const lvs = parseListviews(html);
  const sources: ItemSources = {};
  const npcs = new Map<number, NpcInfo>();
  const objects = new Map<number, ObjectInfo>();
  const quests = new Map<number, QuestInfo>();
  const spells = new Map<number, SpellInfo>();
  const zoneNames: Record<string, string> = {};
  const truncated: Record<string, number> = {};

  const addNpc = (row: Record<string, unknown>) => {
    const info = npcInfo(row);
    if (info) npcs.set(info.id, { ...npcs.get(info.id), ...info });
  };

  for (const lv of lvs) {
    const key = (LOOT_TABLES as Record<string, LootKey | undefined>)[lv.id];
    if (key) {
      const rows = lv.rows.map(lootRow).filter((r): r is LootRow => !!r);
      if (rows.length) {
        rows.sort((a, b) => b[1] - a[1] || b[2] - a[2] || a[0] - b[0]);
        sources[key] = rows;
      }
      const target = LOOT_TARGET[key];
      for (const row of lv.rows) {
        if (target === 'npc') addNpc(row);
        else if (target === 'object') {
          const o = objectInfo(row);
          if (o) objects.set(o.id, o);
        } else if (target === 'zone') {
          const zid = posInt(row['id']);
          const name = rowName(row);
          if (zid !== undefined && name) zoneNames[String(zid)] = name;
        }
      }
      if (lv.truncatedFrom !== undefined) truncated[key] = lv.truncatedFrom;
    } else if (lv.id === 'sold-by') {
      const rows = lv.rows.map(vendorRow).filter((r): r is VendorRow => !!r);
      if (rows.length) sources.soldBy = rows.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      for (const row of lv.rows) addNpc(row);
      if (lv.truncatedFrom !== undefined) truncated['soldBy'] = lv.truncatedFrom;
    } else if (lv.id === 'reward-from-q') {
      const qs = lv.rows.map(questInfo).filter((q): q is QuestInfo => !!q);
      if (qs.length) sources.rewardFrom = qs.map((q) => q.id).sort((a, b) => a - b);
      for (const q of qs) quests.set(q.id, q);
      if (lv.truncatedFrom !== undefined) truncated['rewardFrom'] = lv.truncatedFrom;
    } else if (lv.id === 'created-by-spell') {
      const ss = lv.rows.map(spellInfo).filter((s): s is SpellInfo => !!s);
      if (ss.length) sources.createdBy = ss.map((s) => s.id).sort((a, b) => a - b);
      for (const s of ss) spells.set(s.id, s);
    }
  }
  if (Object.keys(truncated).length) sources.truncated = truncated;

  const rec = gathererRecord(html, 3, id) ?? {};
  const equip = (rec['jsonequip'] && typeof rec['jsonequip'] === 'object' ? rec['jsonequip'] : {}) as Record<string, unknown>;
  const self: ItemSelf = compact({
    name: rowName({ name: rec['name_enus'] }),
    quality: num(rec['quality']),
    icon: str(rec['icon']),
    itemLevel: ownItemLevel(html, id),
    reqLevel: posInt(equip['reqlevel']),
    slotType: posInt(equip['slotbak']),
    sellCopper: posInt(equip['sellprice']),
    buyCopper: posInt(equip['buyprice']),
    avgBuyout: posInt(equip['avgbuyout']),
  });

  const byId = <T extends { id: number }>(m: Map<number, T>) => [...m.values()].sort((a, b) => a.id - b.id);
  return {
    id,
    self,
    sources,
    npcs: byId(npcs),
    objects: byId(objects),
    quests: byId(quests),
    spells: byId(spells),
    zoneNames,
    listviews: listviewCounts(lvs),
  };
}

/** Parse an NPC page. Undefined when the page isn't this NPC's. */
export function parseNpcPage(html: string, id: number): NpcPage | undefined {
  const who = pageIdentity(html);
  if (!who || who.type !== 1 || who.id !== id) return undefined;
  const own = extendRecord(html, 'g_npcs', id);
  const gathered = gathererRecord(html, 1, id);
  const info = npcInfo({ ...(own ?? {}), id, name: own?.['name'] ?? gathered?.['name_enus'] }) ?? { id };

  const spawns: Record<string, Array<[number, number]>> = {};
  const areaMaps: Record<string, number> = {};
  const mapper = parseMapperData(html) ?? {};
  for (const [area, entries] of Object.entries(mapper)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const uiMapId = posInt(e['uiMapId']);
      if (uiMapId === undefined) continue;
      if (Number(area) > 0 && areaMaps[area] === undefined) areaMaps[area] = uiMapId;
      const list = (spawns[String(uiMapId)] ??= []);
      for (const c of Array.isArray(e['coords']) ? (e['coords'] as unknown[]) : []) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          list.push([Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10]);
        }
      }
    }
  }
  for (const [k, list] of Object.entries(spawns)) {
    if (!list.length) delete spawns[k];
    else list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  return { id, info, ...(Object.keys(spawns).length ? { spawns } : {}), areaMaps };
}
