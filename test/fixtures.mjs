// Hand-made pages with the same script blocks Wowhead's item and NPC pages carry
// (g_pageInfo, WH.Gatherer.addData, g_items[..].tooltip_enus, new Listview, g_npcs, g_mapperData).

export const ITEM_PAGE = `<!doctype html><html><head><title>Light Leather - Item - WoW Forever</title></head><body><script>
g_pageInfo = { type: 3, typeId: 2318, name: "Light Leather" };
WH.Gatherer.addData(1, 16, {"454":{"name_enus":"Young Goretusk"}});
WH.Gatherer.addData(3, 16, {"2318":{"name_enus":"Light Leather","quality":1,"icon":"inv_misc_leatherscrap_03","screenshot":{},"jsonequip":{"avgbuyout":98,"itemSquishEraId":0,"sellprice":15},"attainable":0}});
g_items[2318].tooltip_enus = "<table><tr><td><b class=\\"q1\\">Light Leather</b><br>Item Level <!--ilvl-->10<br>Crafting Reagent</td></tr></table>";
var tabsRelated = new Tabs({parent: WH.ge('x'), trackable: "WoW Item"});
new Listview({template: 'npc', id: 'dropped-by', name: WH.TERMS.droppedby, tabs: 'tabsRelated', parent: 'x', extraCols: [Listview.extraCols.count, Listview.extraCols.percent], sort: ['-percent', '-count', 'name'], computeDataFunc: Listview.funcBox.initLootTable, data: [
{"classification":0,"displayName":"Young Goretusk","id":454,"location":[40],"maxlevel":13,"minlevel":12,"name":"Young Goretusk","react":[-1,-1],"type":1,"envChange":{"status":"unchanged"},"count":77,"outof":41880,"personal_loot":0,"pctstack":"{1: 74.026,2: 25.974}"},
{"classification":0,"id":2274,"location":[267],"maxlevel":24,"minlevel":23,"name":"Stanley","react":[0,0],"type":1,"count":4,"outof":7,"pctstack":null}
]});
new Listview({template: 'npc', id: 'sold-by', name: WH.TERMS.soldby, tabs: 'tabsRelated', parent: 'x', extraCols: ['stock', 'cost'], sort: ['popularity'], note: WH.sprintf(WH.TERMS.npcsfounddisplayed_format, 230, 200), _truncated: 1, data: [
{"classification":0,"id":151,"location":[12],"maxlevel":10,"minlevel":10,"name":"Brog Hamfist","react":[1,null],"tag":"General Supplies","type":7,"stock":-1,"cost":[[25]],"stack":5,"popularity":200}
]});
new Listview({template: 'npc', id: 'skinned-from', name: WH.TERMS.skinnedfrom, tabs: 'tabsRelated', parent: 'x', data: [
{"classification":0,"family":11,"id":3256,"location":[17],"maxlevel":18,"minlevel":16,"name":"Sunscale Scytheclaw","react":[-1,-1],"type":1,"count":25106,"outof":35011,"pctstack":"{1: 49.9323,2: 50.0677}"}
]});
new Listview({template: 'object', id: 'mined-from-object', name: WH.TERMS.minedfrom, tabs: 'tabsRelated', parent: 'x', data: [
{"displayName":"Copper Vein","id":1731,"location":[16593,215,17,-1],"name":"Copper Vein","skill":1,"type":-4,"count":148381,"outof":153678,"pctstack":""}
]});
new Listview({template: 'zone', id: 'fished-in', name: WH.TERMS.fishedin, tabs: 'tabsRelated', parent: 'x', data: [
{"category":1,"id":17,"maxlevel":33,"minlevel":10,"name":"The Barrens","territory":1,"count":3,"outof":290731,"pctstack":"{2: 66.6667,6: 33.3333}"}
]});
new Listview({template: 'quest', id: 'reward-from-q', name: WH.TERMS.rewardfrom, tabs: 'tabsRelated', parent: 'x', data: [
{"category":85,"category2":0,"id":8,"level":5,"name":"A Rogue&#039;s Deal","reqlevel":1,"side":2,"xp":110}
]});
new Listview({template: 'spell', id: 'created-by-spell', name: WH.TERMS.createdby, tabs: 'tabsRelated', parent: 'x', data: [
{"cat":11,"creates":[2318,1,1],"id":2881,"learnedat":20,"name":"Light Leather","reagents":[[2934,3]],"skill":[165]}
]});
new Listview({ data: lv_comments0, id: 'comments', name: WH.TERMS.comments, parent: x, tabs: tabsRelated, template: 'comment', });
</script></body></html>`;

export const NPC_PAGE = `<!doctype html><html><head><title>Prowler - NPC - WoW Forever</title></head><body><script>
g_pageInfo = {type: 1, typeId: 118, name: "Prowler"};
WH.Gatherer.addData(1, 16, {"118":{"name_enus":"Prowler","model":11415}});
$.extend(g_npcs[118], {"classification":0,"displayName":"Prowler","displayNames":[],"family":1,"id":118,"location":[12],"maxlevel":10,"minlevel":9,"name":"Prowler","names":[],"react":[-1,-1],"type":1,"envChange":{"status":"unchanged","labels":[],"lines":[]}});
var tabsRelated = new Tabs({parent: WH.ge('x'), trackable: "WoW NPC"});
new Listview({template: 'item', id: 'drops', name: WH.TERMS.drops, tabs: tabsRelated, parent: 'x', data: [{"id":727,"name":"Notched Shortsword","count":31,"outof":20046}]});
g_mapperData = {"12":[{"count":2,"coords":[[69.94,41.3],[65.9,42]],"uiMapId":1429,"uiMapName":"Elwynn Forest"}],"1519":[{"count":1,"coords":[[40,50]],"uiMapId":1453,"uiMapName":"Stormwind City"}]};
var myMapper = new Mapper({"parent":"x","name":"Prowler"});
</script></body></html>`;
