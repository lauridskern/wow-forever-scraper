// Page parsers against small hand-made pages shaped like Wowhead's (see test/fixtures.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItemPage, parseNpcPage, roundChance, roundSamples, averageStack } from '../dist/wowhead/pages.js';
import { parseListviews } from '../dist/wowhead/parse.js';
import { ITEM_PAGE, NPC_PAGE } from './fixtures.mjs';

test('rounding keeps 3 significant digits of a chance and 2 of a large sample count', () => {
  assert.equal(roundChance(77, 41880), 0.184);
  assert.equal(roundChance(25106, 35011), 71.7);
  assert.equal(roundChance(3, 290731), 0.00103);
  assert.equal(roundChance(5, 5), 100);
  assert.equal(roundChance(0, 5), 0);
  assert.equal(roundSamples(41880), 42000);
  assert.equal(roundSamples(153678), 150000);
  assert.equal(roundSamples(136), 140);
  assert.equal(roundSamples(97), 97);
});

test('average stack from the spread, or the range, or nothing when it is always 1', () => {
  assert.equal(averageStack('{1: 74.026,2: 25.974}'), 1.26);
  assert.equal(averageStack('{2: 66.6667,6: 33.3333}'), 3.33);
  assert.equal(averageStack(''), undefined);
  assert.equal(averageStack(null, [1, 1]), undefined);
  assert.equal(averageStack(null, [2, 4]), 3);
});

test('a cut-short table says how many rows exist', () => {
  const lvs = parseListviews(ITEM_PAGE);
  assert.equal(lvs.find((l) => l.id === 'sold-by').truncatedFrom, 230);
  assert.equal(lvs.find((l) => l.id === 'dropped-by').truncatedFrom, undefined);
});

test('an item page becomes its own record plus every source table', () => {
  const p = parseItemPage(ITEM_PAGE, 2318);
  assert.deepEqual(p.self, { name: 'Light Leather', quality: 1, icon: 'inv_misc_leatherscrap_03', itemLevel: 10, sellCopper: 15, avgBuyout: 98 });
  // Highest chance first.
  assert.deepEqual(p.sources.droppedBy, [[2274, 57.1, 7], [454, 0.184, 42000, 1.26]]);
  assert.deepEqual(p.sources.soldBy, [[151, 25, -1, 5]]);
  assert.deepEqual(p.sources.skinnedFrom, [[3256, 71.7, 35000, 1.5]]);
  assert.deepEqual(p.sources.minedFrom, [[1731, 96.6, 150000]]);
  assert.deepEqual(p.sources.fishedIn, [[17, 0.00103, 290000, 3.33]]);
  assert.deepEqual(p.sources.rewardFrom, [8]);
  assert.deepEqual(p.sources.createdBy, [2881]);
  assert.deepEqual(p.sources.truncated, { soldBy: 230 });
  assert.deepEqual(p.zoneNames, { 17: 'The Barrens' });
  assert.deepEqual(p.objects, [{ id: 1731, name: 'Copper Vein', type: -4, skill: 1, zones: [17, 215, 16593] }]);
  assert.deepEqual(p.quests, [{ id: 8, name: "A Rogue's Deal", level: 5, reqLevel: 1, side: 2, category: 85 }]);
  assert.deepEqual(p.spells, [{ id: 2881, name: 'Light Leather', skill: [165], learnedAt: 20, reagents: [[2934, 3]], creates: [2318, 1, 1] }]);
  const boar = p.npcs.find((n) => n.id === 454);
  assert.deepEqual(boar, { id: 454, name: 'Young Goretusk', minLevel: 12, maxLevel: 13, classification: 0, type: 1, react: [-1, -1], zones: [40] });
  assert.equal(p.npcs.find((n) => n.id === 151).tag, 'General Supplies');
  assert.equal(p.npcs.find((n) => n.id === 3256).family, 11);
  assert.ok(p.listviews['dropped-by'] === 2 && 'comments' in p.listviews);
});

test("a page that isn't the item asked for is rejected", () => {
  assert.equal(parseItemPage(ITEM_PAGE, 2319), undefined);
  assert.equal(parseItemPage('<html>Forever Items</html>', 2318), undefined);
  assert.equal(parseNpcPage(ITEM_PAGE, 2318), undefined);
});

test('an NPC page gives its row and its spawn points by uiMapID', () => {
  const p = parseNpcPage(NPC_PAGE, 118);
  assert.deepEqual(p.info, { id: 118, name: 'Prowler', minLevel: 9, maxLevel: 10, classification: 0, type: 1, family: 1, react: [-1, -1], zones: [12] });
  assert.deepEqual(p.spawns, { 1429: [[65.9, 42], [69.9, 41.3]], 1453: [[40, 50]] });
  assert.deepEqual(p.areaMaps, { 12: 1429, 1519: 1453 });
});
