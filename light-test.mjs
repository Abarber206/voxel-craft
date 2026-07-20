// Behavioural tests for the voxel light engine, extracted verbatim from index.html
// between the __LIGHT_SRC__ markers and run against a synthetic world. These assert
// the things the player actually sees: caves are dark, torches light the room they
// are in, light crosses chunk borders, and edits both remove and restore light.
// Run: node light-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const here = path.dirname(new URL(import.meta.url).pathname);
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const src = html.match(/\/\*__LIGHT_SRC_START__\*\/([\s\S]*?)\/\*__LIGHT_SRC_END__\*\//)[1];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
    ok ? pass++ : fail++;
};

const CS = 16, WORLD_CY = 7, WORLD_H = WORLD_CY * CS;
const AIR = 0, STONE = 3, GLASS = 22, TORCH = 23;

// ---- harness world: the same chunk map shape the game uses -------------------
function makeWorld() {
    const chunks = new Map();
    const key = (cx, cy, cz) => cx + ',' + cy + ',' + cz;
    const remeshed = [];
    const ctx = {
        chunks, key, CS, WORLD_CY, WORLD_H, performance, Math, console,
        requestRemesh: (cx, cy, cz) => remeshed.push(key(cx, cy, cz)),
        getBlock(wx, wy, wz) {
            if (wy < 0) return STONE;
            if (wy >= WORLD_H) return AIR;
            const ch = chunks.get(key(Math.floor(wx / CS), Math.floor(wy / CS), Math.floor(wz / CS)));
            if (!ch || !ch.voxels) return undefined;
            return ch.voxels[((wy - ch.cy * CS) * CS + (wz - ch.cz * CS)) * CS + (wx - ch.cx * CS)];
        }
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const api = vm.runInContext(
        '({ tryLightColumn, lightTick, lightIdle, relightEdit, getSky, getBlk, litDirty, litColumns })', ctx);

    // Ground at y < GROUND is solid stone; everything above is open air.
    const GROUND = 40;
    api.addColumn = (cx, cz, edit) => {
        for (let cy = 0; cy < WORLD_CY; cy++) {
            const voxels = new Uint8Array(CS * CS * CS);
            for (let y = 0; y < CS; y++) for (let z = 0; z < CS; z++) for (let x = 0; x < CS; x++)
                voxels[(y * CS + z) * CS + x] = (cy * CS + y) < GROUND ? STONE : AIR;
            chunks.set(key(cx, cy, cz), { cx, cy, cz, voxels, light: null, mesh: null, rev: 0, state: 'ready' });
        }
        if (edit) edit((wx, wy, wz, id) => {
            const ch = chunks.get(key(Math.floor(wx / CS), Math.floor(wy / CS), Math.floor(wz / CS)));
            ch.voxels[((wy - ch.cy * CS) * CS + (wz - ch.cz * CS)) * CS + (wx - ch.cx * CS)] = id;
        }, cx, cz);
    };
    api.poke = (wx, wy, wz, id) => {   // write a voxel without touching the light state
        const ch = chunks.get(key(Math.floor(wx / CS), Math.floor(wy / CS), Math.floor(wz / CS)));
        ch.voxels[((wy - ch.cy * CS) * CS + (wz - ch.cz * CS)) * CS + (wx - ch.cx * CS)] = id;
    };
    api.setBlock = (wx, wy, wz, id) => { api.poke(wx, wy, wz, id); api.relightEdit(wx, wy, wz, id); };
    api.settle = () => { for (let i = 0; i < 4000 && !api.lightIdle(); i++) api.lightTick(); };
    api.remeshed = remeshed;
    api.GROUND = GROUND;
    return api;
}

// ---- 1. skylight: open ground lit, sealed rock dark --------------------------
{
    const w = makeWorld();
    w.addColumn(0, 0);
    w.tryLightColumn(0, 0);
    w.settle();
    check('open air above ground is full skylight', w.getSky(8, w.GROUND + 3, 8) === 15,
        'got ' + w.getSky(8, w.GROUND + 3, 8));
    check('first air voxel on the surface is full skylight', w.getSky(8, w.GROUND, 8) === 15);
    check('solid rock below the surface has no skylight', w.getSky(8, w.GROUND - 4, 8) === 0);
    check('skylight falls straight down without attenuating', w.getSky(8, w.GROUND + 30, 8) === 15);
}

// ---- 2. a sealed room stays pitch black at noon -------------------------------
{
    const w = makeWorld();
    // hollow a 5x3x5 room fully inside the rock: no path to the sky
    w.addColumn(0, 0, set => {
        for (let y = 20; y < 23; y++) for (let z = 5; z < 10; z++) for (let x = 5; x < 10; x++)
            set(x, y, z, AIR);
    });
    w.tryLightColumn(0, 0);
    w.settle();
    check('sealed underground room gets zero skylight', w.getSky(7, 21, 7) === 0, 'got ' + w.getSky(7, 21, 7));
    check('sealed underground room gets zero block light', w.getBlk(7, 21, 7) === 0);

    // ---- 3. a torch lights that room, with correct falloff ----------------
    w.setBlock(7, 21, 7, TORCH);
    w.settle();
    check('torch emits light level 14 at its own voxel', w.getBlk(7, 21, 7) === 14, 'got ' + w.getBlk(7, 21, 7));
    check('torch light drops exactly 1 per step', w.getBlk(8, 21, 7) === 13 && w.getBlk(9, 21, 7) === 12,
        w.getBlk(8, 21, 7) + ',' + w.getBlk(9, 21, 7));
    check('torch light does not leak through stone', w.getBlk(7, 21, 11) === 0, 'got ' + w.getBlk(7, 21, 11));
    check('torch does not create skylight', w.getSky(7, 21, 7) === 0);
    check('lighting the room queued re-meshes', w.remeshed.length > 0, w.remeshed.length + ' chunk meshes');

    // ---- 4. removing the torch removes its light -------------------------
    w.setBlock(7, 21, 7, AIR);
    w.settle();
    check('breaking the torch returns the room to darkness',
        w.getBlk(7, 21, 7) === 0 && w.getBlk(8, 21, 7) === 0 && w.getBlk(9, 21, 7) === 0,
        [w.getBlk(7, 21, 7), w.getBlk(8, 21, 7), w.getBlk(9, 21, 7)].join(','));
}

// ---- 5. light crosses chunk borders ------------------------------------------
{
    const w = makeWorld();
    // two adjacent columns, then a tunnel bored along x straight through the seam at
    // x=16 — bored only after BOTH columns exist, since it writes into both of them
    w.addColumn(0, 0);
    w.addColumn(1, 0);
    for (let x = 8; x < 26; x++) w.poke(x, 21, 8, AIR);
    w.tryLightColumn(0, 0); w.tryLightColumn(1, 0);
    w.settle();
    w.setBlock(10, 21, 8, TORCH);       // in chunk 0
    w.settle();
    check('torch light crosses the chunk seam', w.getBlk(17, 21, 8) === 7, 'got ' + w.getBlk(17, 21, 8));
    check('torch light dies out at range 14', w.getBlk(23, 21, 8) === 1 && w.getBlk(24, 21, 8) === 0,
        w.getBlk(23, 21, 8) + ',' + w.getBlk(24, 21, 8));
    check('re-mesh was requested on BOTH sides of the seam',
        w.remeshed.some(k => k.startsWith('0,1,')) && w.remeshed.some(k => k.startsWith('1,1,')));
}

// ---- 6. edits change skylight: roofing a column darkens what's under it -------
{
    const w = makeWorld();
    w.addColumn(0, 0, set => { for (let y = 30; y < 40; y++) set(8, y, 8, AIR); }); // a shaft to the sky
    w.tryLightColumn(0, 0);
    w.settle();
    check('open shaft carries skylight to its floor', w.getSky(8, 30, 8) === 15, 'got ' + w.getSky(8, 30, 8));
    w.setBlock(8, 39, 8, STONE);         // cap the shaft
    w.settle();
    check('capping the shaft removes skylight all the way down', w.getSky(8, 30, 8) === 0,
        'got ' + w.getSky(8, 30, 8));
    w.setBlock(8, 39, 8, AIR);           // re-open it
    w.settle();
    check('re-opening the shaft restores skylight', w.getSky(8, 30, 8) === 15, 'got ' + w.getSky(8, 30, 8));
    w.setBlock(8, 39, 8, GLASS);         // glass must not block light
    w.settle();
    check('glass lets skylight through', w.getSky(8, 30, 8) === 15, 'got ' + w.getSky(8, 30, 8));
}

// ---- 7. the engine settles, and does so in bounded time ----------------------
{
    const w = makeWorld();
    const t0 = performance.now();
    for (let cx = 0; cx < 3; cx++) for (let cz = 0; cz < 3; cz++) w.addColumn(cx, cz);
    for (let cx = 0; cx < 3; cx++) for (let cz = 0; cz < 3; cz++) w.tryLightColumn(cx, cz);
    let ticks = 0;
    while (!w.lightIdle() && ticks < 4000) { w.lightTick(); ticks++; }
    check('9-column region reaches a settled light state', w.lightIdle(), ticks + ' ticks');
    // Ticks, not milliseconds: this runs inside a vm context, which is ~50x slower than
    // the browser, so wall-clock here says nothing useful. One tick is one frame's
    // 3ms budget, so <60 ticks means the region lights up inside a second of streaming.
    check('and settles within a second of frames', ticks < 60, ticks + ' frames for 9 columns');
    check('every surface voxel across the region ended up sky-lit',
        [[5, 5], [20, 20], [40, 40], [8, 40]].every(([x, z]) => w.getSky(x, w.GROUND + 1, z) === 15));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
