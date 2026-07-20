// Behavioral tests for game-systems.js v2: InventoryManager stacking/overflow/
// filtering, ItemDB generation (tool tiers, armor), 3x3 Crafting matcher with
// real MC recipe shapes, DataSerializer round-trips, SaveManager lifecycle.
// Run: node systems-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8');
const sandbox = { console, btoa, atob, setInterval, clearInterval, setTimeout, clearTimeout, Math, document: undefined };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { ItemDB, InventoryManager, Crafting, DataSerializer, SaveManager, Smelting } =
    vm.runInContext('({ ItemDB, InventoryManager, Crafting, DataSerializer, SaveManager, Smelting })', sandbox);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
    ok ? pass++ : fail++;
};
const s = id => ({ id, n: 1 });
const G = places => { // build a 3x3 grid from {index: id}
    const g = Array(9).fill(null);
    for (const [i, id] of Object.entries(places)) g[+i] = s(id);
    return g;
};

// ---- ItemDB: generated content --------------------------------------------
{
    check('item catalog is large (blocks + materials + 25 tools + 12 armor)', ItemDB.count() >= 60, ItemDB.count() + ' items');
    const dp = ItemDB.get('pickaxe_diamond'), ws = ItemDB.get('sword_wood');
    check('tool tiers generated (diamond pickaxe tier 4, wood sword dmg 4)',
        dp && dp.tier === 4 && dp.tool === 'pickaxe' && dp.stack === 1 && ws && ws.damage === 4);
    const gh = ItemDB.get('helmet_gold'), db = ItemDB.get('boots_diamond');
    check('armor generated with MC points (gold helm +2, diamond boots +3)',
        gh && gh.armor === 2 && gh.armorSlot === 0 && db && db.armor === 3 && db.armorSlot === 3);
    check('block mapping covers new blocks', ItemDB.byBlock[9] === 'cobblestone' &&
        ItemDB.byBlock[17] === 'crafting_table' && ItemDB.byBlock[16] === 'diamond_ore');
    // survival-mode support: real MC tool durabilities
    check('tool durabilities are MC-accurate (wood 59, iron 250, diamond 1561)',
        ItemDB.get('pickaxe_wood').dur === 59 && ItemDB.get('axe_iron').dur === 250 &&
        ItemDB.get('sword_diamond').dur === 1561 && ItemDB.get('dirt').dur === undefined);
    const mkT = ItemDB.mk('shovel_gold', 1), mkB = ItemDB.mk('stone', 5);
    check('mk() gives tools full durability, blocks none',
        mkT.dur === 32 && mkB.dur === undefined && mkB.n === 5);
    check('catalog list covers every item', ItemDB.list().length === ItemDB.count());
}

// ---- durability persistence -------------------------------------------------
{
    const a = new InventoryManager();
    a.addItem('pickaxe_iron', 1);
    check('addItem creates tools at full durability', a.hotbar[0].dur === 250);
    a.hotbar[0].dur = 97;                       // wear it down
    const b = new InventoryManager();
    b.load(JSON.parse(JSON.stringify(a.serialize())));
    check('worn durability survives save -> load', b.hotbar[0].dur === 97);
    const c = new InventoryManager();
    c.load({ main: [], hotbar: [['pickaxe_iron', 1]], armor: [], offhand: [] }); // legacy save, no dur
    check('legacy tools without saved durability backfill to full', c.hotbar[0].dur === 250);
}

// ---- REGRESSION: a new world must not inherit the previous world's stuff ----
{
    const inv = new InventoryManager();
    inv.addItem('diamond', 64); inv.addItem('pickaxe_diamond', 1);
    inv.armor[0] = { id: 'helmet_iron', n: 1 };
    inv.offhand[0] = { id: 'torch', n: 12 };
    inv.craft[0] = { id: 'plank', n: 4 };
    inv.load(null);                                   // <- starting a brand-new world
    const empty = L => L.every(s => s === null);
    check('NEW WORLD: load(null) wipes hotbar/main/armor/offhand/craft (no carryover)',
        empty(inv.hotbar) && empty(inv.main) && empty(inv.armor) &&
        empty(inv.offhand) && empty(inv.craft) && inv.craftOut[0] === null);
    const inv2 = new InventoryManager();
    inv2.addItem('stone', 30);
    inv2.load(undefined);                             // defensive: undefined behaves the same
    check('NEW WORLD: load(undefined) also wipes', inv2.hotbar.every(s => s === null));
}

// ---- REGRESSION: "Create & Play" must never reopen an existing world ---------
{
    const mgr = new SaveManager({ binary: false, onToast: () => {}, getState: () => ({
        meta: { worldName: NAME, seed: 1, mode: 'survival', savedAt: 1 }, player: [], chunks: []
    }) });
    // mirror of index.html's nextFreeName()
    function nextFreeName(base) {
        if (!mgr.exists(base)) return base;
        const m = base.match(/^(.*?)(\d+)$/);
        const stem = (m ? m[1] : base + ' ').replace(/\s+$/, ' ');
        let n = m ? +m[2] + 1 : 2;
        while (mgr.exists(stem + n) && n < 999) n++;
        return stem + n;
    }
    let NAME = 'World 1';
    await mgr.save();                                  // "World 1" now exists
    check('fresh name when none taken', nextFreeName('Cave Base') === 'Cave Base');
    check('"World 1" taken -> "World 2" (does NOT reopen World 1)', nextFreeName('World 1') === 'World 2');
    NAME = 'World 2'; await mgr.save();
    check('"World 1" + "World 2" taken -> "World 3"', nextFreeName('World 1') === 'World 3');
    NAME = 'Base'; await mgr.save();
    check('non-numeric name gets a numeric suffix', nextFreeName('Base') === 'Base 2');
    for (const n of ['World 1', 'World 2', 'Base']) mgr.deleteWorld(n);
}

// ---- InventoryManager: stacking + overflow + filtering ----------------------
{
    const inv = new InventoryManager();
    check('add 70 dirt -> 64 + 6 spill into next slot',
        inv.addItem('dirt', 70) === 0 && inv.hotbar[0].n === 64 && inv.hotbar[1].n === 6);
    inv.addItem('dirt', 58);
    check('stack tops up to MaxStackSize before opening a new slot',
        inv.hotbar[1].n === 64 && !inv.hotbar[2]);
    const inv2 = new InventoryManager();
    check('apples cap at 16/stack; gear at 1/stack',
        inv2.addItem('apple', 20) === 0 && inv2.hotbar[0].n === 16 && inv2.hotbar[1].n === 4 &&
        inv2.addItem('helmet_iron', 2) === 0 && inv2.hotbar[2].n === 1 && inv2.hotbar[3].n === 1);
    const inv3 = new InventoryManager();
    let left = 0;
    for (let i = 0; i < 37; i++) left = inv3.addItem('stone', 64);
    check('full 36-slot inventory reports leftover + exact canFit', left === 64 &&
        !inv3.canFit('stone', 1) && !inv3.canFit('dirt', 1));
    check('armor slot filtering (helmet only slot 0; craftOut never)',
        inv3.canPlace('armor', 0, 'helmet_iron') === true &&
        inv3.canPlace('armor', 1, 'helmet_iron') === false &&
        inv3.canPlace('armor', 0, 'stone') === false &&
        inv3.canPlace('craftOut', 0, 'stone') === false);
    check('craft grid is 3x3 (9 slots)', inv3.craft.length === 9);
    const a = new InventoryManager();
    a.addItem('log', 12); a.addItem('apple', 3);
    a.armor[0] = { id: 'helmet_iron', n: 1 };
    a.offhand[0] = { id: 'stick', n: 9 };
    const b = new InventoryManager();
    b.load(JSON.parse(JSON.stringify(a.serialize())));
    check('inventory serialize -> load round-trip',
        JSON.stringify(b.serialize()) === JSON.stringify(a.serialize()));
    const c = new InventoryManager();
    c.load({ main: [['no_such_item', 5]], hotbar: [['dirt', 3]], armor: [], offhand: [] });
    check('unknown items from old saves collapse to empty slots',
        c.main[0] === null && c.hotbar[0].n === 3);
}

// ---- Crafting: 3x3 shaped + shapeless, position-independent -----------------
{
    check('recipe book is large', Crafting.count() >= 40, Crafting.count() + ' recipes');
    check('1 log -> 4 planks (shapeless, any slot)',
        JSON.stringify(Crafting.match(G({ 0: 'log' }))) === '{"id":"plank","n":4}' &&
        JSON.stringify(Crafting.match(G({ 8: 'log' }))) === '{"id":"plank","n":4}');
    check('2 vertical planks -> sticks (any column, incl. offset)',
        Crafting.match(G({ 0: 'plank', 3: 'plank' })).id === 'stick' &&
        Crafting.match(G({ 2: 'plank', 5: 'plank' })).id === 'stick' &&
        Crafting.match(G({ 4: 'plank', 7: 'plank' })).id === 'stick');
    check('horizontal planks do NOT make sticks',
        Crafting.match(G({ 0: 'plank', 1: 'plank' })) === null);
    check('2x2 planks -> crafting table',
        Crafting.match(G({ 0: 'plank', 1: 'plank', 3: 'plank', 4: 'plank' })).id === 'crafting_table' &&
        Crafting.match(G({ 4: 'plank', 5: 'plank', 7: 'plank', 8: 'plank' })).id === 'crafting_table');
    check('iron pickaxe: MMM / _S_ / _S_',
        Crafting.match(G({ 0: 'iron_ingot', 1: 'iron_ingot', 2: 'iron_ingot', 4: 'stick', 7: 'stick' })).id === 'pickaxe_iron');
    check('wood axe: MM / MS / _S (left-aligned 2x3)',
        Crafting.match(G({ 0: 'plank', 1: 'plank', 3: 'plank', 4: 'stick', 7: 'stick' })).id === 'axe_wood');
    check('stone sword: M / M / S column',
        Crafting.match(G({ 1: 'cobblestone', 4: 'cobblestone', 7: 'stick' })).id === 'sword_stone');
    check('diamond boots: M_M / M_M (rows can sit anywhere)',
        Crafting.match(G({ 3: 'diamond', 5: 'diamond', 6: 'diamond', 8: 'diamond' })).id === 'boots_diamond');
    check('gold chestplate: M_M / MMM / MMM',
        Crafting.match(G({ 0: 'gold_ingot', 2: 'gold_ingot', 3: 'gold_ingot', 4: 'gold_ingot',
            5: 'gold_ingot', 6: 'gold_ingot', 7: 'gold_ingot', 8: 'gold_ingot' })).id === 'chestplate_gold');
    check('furnace: 8 cobblestone ring',
        Crafting.match(G({ 0: 'cobblestone', 1: 'cobblestone', 2: 'cobblestone', 3: 'cobblestone',
            5: 'cobblestone', 6: 'cobblestone', 7: 'cobblestone', 8: 'cobblestone' })).id === 'furnace');
    check('mossy cobble: shapeless cobble + leaves',
        Crafting.match(G({ 0: 'cobblestone', 4: 'leaves' })).id === 'mossy_cobblestone' &&
        Crafting.match(G({ 8: 'leaves', 2: 'cobblestone' })).id === 'mossy_cobblestone');
    check('mixed junk matches nothing',
        Crafting.match(G({ 0: 'log', 1: 'stone' })) === null &&
        Crafting.match(G({ 0: 'iron_ingot', 1: 'iron_ingot', 2: 'iron_ingot', 4: 'plank', 7: 'stick' })) === null);
    check('TORCH recipe: coal (or charcoal) above stick -> 4, ANY column/offset',
        JSON.stringify(Crafting.match(G({ 0: 'coal', 3: 'stick' }))) === '{"id":"torch","n":4}' &&
        Crafting.match(G({ 2: 'coal', 5: 'stick' })).id === 'torch' &&
        Crafting.match(G({ 4: 'charcoal', 7: 'stick' })).id === 'torch' &&
        Crafting.match(G({ 0: 'stick', 3: 'coal' })) === null);   // upside down: no match
}

// ---- Smelting (furnace rules) ----------------------------------------------
{
    check('smelting recipes: iron/gold ore -> ingots, sand -> glass, cobble -> stone, log -> charcoal',
        Smelting.result('iron_ore') === 'iron_ingot' && Smelting.result('gold_ore') === 'gold_ingot' &&
        Smelting.result('sand') === 'glass' && Smelting.result('cobblestone') === 'stone' &&
        Smelting.result('log') === 'charcoal' && Smelting.result('dirt') === null);
    check('fuel burn times: 1 coal = 8 smelts (80s / 10s per item)',
        Smelting.fuelTime('coal') === 80 && Smelting.TIME === 10 &&
        Smelting.fuelTime('coal') / Smelting.TIME === 8 &&
        Smelting.isFuel('plank') && Smelting.isFuel('stick') && !Smelting.isFuel('stone'));
    check('new blocks/items registered (glass, torch, redstone ore, charcoal)',
        ItemDB.byBlock[22] === 'glass' && ItemDB.byBlock[23] === 'torch' &&
        ItemDB.byBlock[24] === 'redstone_ore' && !!ItemDB.get('charcoal') && !!ItemDB.get('redstone'));
    check('mob foods: raw porkchop smelts to cooked, cooked heals more',
        Smelting.result('raw_porkchop') === 'cooked_porkchop' &&
        ItemDB.get('raw_porkchop').heal === 2 && ItemDB.get('cooked_porkchop').heal === 8 &&
        ItemDB.get('raw_porkchop').type === 'Consumable' && !!ItemDB.get('rotten_flesh'));
}

// ---- REGRESSION: every placeable block needs art for the player's hand -------
// The torch showed up as a "hump of stone" because HAND_TILES had no entry for it
// and silently fell back to HAND_TILES[3] (stone). This catches any future gap.
{
    const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
    const handBlock = html.match(/const HAND_TILES = \{([\s\S]*?)\n        \};/);
    const spriteBlock = html.match(/const SPRITE_BLOCKS = new Set\(\[([^\]]*)\]\)/);
    const cubeIds = new Set();
    if (handBlock) for (const m of handBlock[1].matchAll(/(\d+):\s*\[/g)) cubeIds.add(+m[1]);
    const spriteIds = new Set((spriteBlock ? spriteBlock[1] : '').split(',')
        .map(s => parseInt(s, 10)).filter(n => !isNaN(n)));
    check('HAND_TILES + SPRITE_BLOCKS parsed from index.html',
        cubeIds.size > 15 && spriteIds.size >= 1, cubeIds.size + ' cubes, ' + spriteIds.size + ' sprites');
    const missing = [];
    for (const [blockId, itemId] of Object.entries(ItemDB.byBlock)) {
        const id = +blockId;
        if (!cubeIds.has(id) && !spriteIds.has(id)) missing.push(itemId + '(' + id + ')');
    }
    check('every placeable block has hand art (no silent stone fallback)',
        missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : 'all covered');
    check('torch is held as a sprite, not a cube', spriteIds.has(23) && !cubeIds.has(23));
}

// ---- DataSerializer ---------------------------------------------------------
{
    const edits = [['0,1,0', [[0, 3], [4095, 0], [123, 8]]], ['-2,0,-13', [[512, 7]]]];
    const j = DataSerializer.encodeChunks(edits, false);
    const b = DataSerializer.encodeChunks(edits, true);
    check('JSON chunk encoding round-trips', JSON.stringify(DataSerializer.decodeChunks(j)) === JSON.stringify(edits));
    check('binary chunk encoding round-trips', JSON.stringify(DataSerializer.decodeChunks(b)) === JSON.stringify(edits));
    check('binary is the compact option', b.length <= j.length, b.length + ' vs ' + j.length + ' chars');
    check('empty diff round-trips', DataSerializer.decodeChunks(DataSerializer.encodeChunks([], true)).length === 0);
}

// ---- SaveManager ------------------------------------------------------------
{
    const state = {
        meta: { worldName: 'TestWorld', seed: 4242, timeOfDay: 0.31, weather: 'clear', totalPlayTime: 77, savedAt: 1 },
        player: [{ pos: [1.5, 30, 2.5], yaw: 0.5, pitch: -0.1, health: 20, activeSlot: 3,
                   inv: new InventoryManager().serialize() }],
        chunks: [['0,0,0', [[7, 3]]]]
    };
    const mgr = new SaveManager({ binary: true, onToast: () => {}, getState: () => state });
    await mgr.save();
    const loaded = mgr.load('TestWorld');
    check('save -> load: metadata + player + binary chunks intact',
        loaded.meta.seed === 4242 && loaded.meta.totalPlayTime === 77 &&
        loaded.player[0].activeSlot === 3 && loaded.player[0].inv.main.length === 27 &&
        JSON.stringify(loaded.chunks) === JSON.stringify(state.chunks));
    check('listWorlds finds it', mgr.listWorlds().some(w => w.worldName === 'TestWorld'));
    mgr.deleteWorld('TestWorld');
    check('deleteWorld removes all three files',
        !mgr.exists('TestWorld') && mgr.load('TestWorld').meta === null && mgr.load('TestWorld').chunks.length === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
