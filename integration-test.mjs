// End-to-end check of the lighting pipeline on REAL terrain: boots the actual worker
// source and the actual light engine from index.html, streams a column through
// generate -> flood fill -> remesh exactly the way the game does, and then asserts on
// the vertex buffer that comes out the other side. This is the test that would have
// caught "there is no lighting": it inspects what the GPU is actually handed.
// Run: node integration-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const here = path.dirname(new URL(import.meta.url).pathname);
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
    ok ? pass++ : fail++;
};

const CS = 16, PS = 18, WORLD_CY = 7, WORLD_H = 112, SEED = 1337;
const AIR = 0, STONE = 3, TORCH = 23;

// ---- boot the real worker ----------------------------------------------------
let received = null;
const wsb = { self: { postMessage: m => { received = m; } }, performance, console };
vm.createContext(wsb);
vm.runInContext(html.match(/\/\*__WORKER_SRC_BEGIN__\*\/([\s\S]*?)\/\*__WORKER_SRC_END__\*\//)[1] +
    '\nworkerMain.call(self);', wsb);
const runWorker = msg => { received = null; wsb.self.onmessage({ data: msg }); return received; };

// ---- boot the real light engine over a real chunk map ------------------------
const chunks = new Map();
const key = (cx, cy, cz) => cx + ',' + cy + ',' + cz;
const remeshQueue = [];
const lsb = {
    chunks, key, CS, WORLD_CY, WORLD_H, performance, Math, console,
    requestRemesh: (cx, cy, cz) => remeshQueue.push([cx, cy, cz]),
    getBlock(wx, wy, wz) {
        if (wy < 0) return STONE;
        if (wy >= WORLD_H) return AIR;
        const ch = chunks.get(key(Math.floor(wx / CS), Math.floor(wy / CS), Math.floor(wz / CS)));
        if (!ch || !ch.voxels) return undefined;
        return ch.voxels[((wy - ch.cy * CS) * CS + (wz - ch.cz * CS)) * CS + (wx - ch.cx * CS)];
    }
};
vm.createContext(lsb);
vm.runInContext(html.match(/\/\*__LIGHT_SRC_START__\*\/([\s\S]*?)\/\*__LIGHT_SRC_END__\*\//)[1], lsb);
const L = vm.runInContext('({ tryLightColumn, lightTick, lightIdle, relightEdit, getSky, getBlk })', lsb);
const settle = () => { for (let i = 0; i < 8000 && !L.lightIdle(); i++) L.lightTick(); };

// Mirrors requestRemesh(): interior straight-copied, 1-voxel shell from neighbours.
function remesh(cx, cy, cz) {
    const ch = chunks.get(key(cx, cy, cz));
    const padded = new Uint8Array(PS * PS * PS), plight = new Uint8Array(PS * PS * PS);
    for (let y = 0; y < CS; y++) for (let z = 0; z < CS; z++) {
        const s = (y * CS + z) * CS, d = ((y + 1) * PS + (z + 1)) * PS + 1;
        for (let x = 0; x < CS; x++) {
            padded[d + x] = ch.voxels[s + x];
            if (ch.light) plight[d + x] = ch.light[s + x];
        }
    }
    const x0 = cx * CS - 1, y0 = cy * CS - 1, z0 = cz * CS - 1;
    for (let py = 0; py < PS; py++) for (let pz = 0; pz < PS; pz++) for (let px = 0; px < PS; px++) {
        if (px && py && pz && px < PS - 1 && py < PS - 1 && pz < PS - 1) continue;
        const wx = x0 + px, wy = y0 + py, wz = z0 + pz;
        const b = lsb.getBlock(wx, wy, wz), i = (py * PS + pz) * PS + px;
        padded[i] = b === undefined ? 0 : b;
        plight[i] = (L.getSky(wx, wy, wz) << 4) | L.getBlk(wx, wy, wz);
    }
    return runWorker({ type: 'remesh', cx, cy, cz, rev: 1, padded: padded.buffer, plight: plight.buffer });
}

// ---- stream a 3x3 patch of real terrain in, exactly like the game does -------
for (let cx = 0; cx < 3; cx++) for (let cz = 0; cz < 3; cz++)
    for (let cy = 0; cy < WORLD_CY; cy++) {
        const g = runWorker({ type: 'generate', cx, cy, cz, seed: SEED });
        chunks.set(key(cx, cy, cz), { cx, cy, cz, voxels: new Uint8Array(g.voxels), light: null, mesh: null, rev: 0 });
    }
for (let cx = 0; cx < 3; cx++) for (let cz = 0; cz < 3; cz++) L.tryLightColumn(cx, cz);
settle();

check('streaming real terrain queues chunk re-meshes', remeshQueue.length > 0, remeshQueue.length + ' queued');

// ---- 1. the sky reaches the surface, and nothing reaches the bedrock ---------
{
    let surfaceLit = 0, probed = 0, deepLit = 0, deepProbed = 0;
    for (let wx = 4; wx < 44; wx += 3) for (let wz = 4; wz < 44; wz += 3) {
        let top = -1;
        for (let wy = WORLD_H - 1; wy >= 0; wy--) if (lsb.getBlock(wx, wy, wz) > 0) { top = wy; break; }
        if (top < 0 || top >= WORLD_H - 1) continue;
        probed++;
        if (L.getSky(wx, top + 1, wz) === 15) surfaceLit++;   // the air just above ground
        deepProbed++;
        if (L.getSky(wx, 1, wz) > 0) deepLit++;               // one voxel above bedrock
    }
    check('every open-air voxel above the terrain surface is fully sky-lit',
        probed > 50 && surfaceLit === probed, surfaceLit + '/' + probed);
    check('nothing at bedrock depth receives skylight', deepProbed > 50 && deepLit === 0,
        deepLit + '/' + deepProbed + ' lit');
}

// ---- 2. the baked mesh actually carries that light ---------------------------
{
    // find a chunk containing the surface and mesh it
    let target = null;
    for (let cy = WORLD_CY - 1; cy >= 0 && !target; cy--) {
        const r = remesh(1, cy, 1);
        if (r.position.byteLength > 0 && new Uint8Array(r.lit).some((v, i) => i % 2 === 0 && v > 200)) target = r;
    }
    check('a surface chunk meshes with bright skylight baked into its vertices', !!target);
    if (target) {
        const lit = new Uint8Array(target.lit);
        let sky = 0, n = 0;
        for (let i = 0; i < lit.length; i += 2) { sky += lit[i]; n++; }
        check('alight is one vec2 per vertex', n === target.position.byteLength / 12, n + ' vs ' + target.position.byteLength / 12);
        check('surface chunk is genuinely bright on average', sky / n > 90, 'mean sky ' + (sky / n).toFixed(0) + '/255');
    }
    // a deep chunk with no sky path must bake to black
    const deep = remesh(1, 0, 1);
    if (deep.position.byteLength > 0) {
        const dl = new Uint8Array(deep.lit);
        let maxSky = 0;
        for (let i = 0; i < dl.length; i += 2) maxSky = Math.max(maxSky, dl[i]);
        check('the bottom chunk bakes to zero skylight (dark caves, not a lit box)', maxSky === 0,
            'max sky ' + maxSky);
    }
}

// ---- 3. a torch in a carved-out pocket lights the mesh around it -------------
{
    // hollow a 5x5x5 pocket deep in the rock, well below any cave system we might hit
    const CY = 1, base = CY * CS + 4;
    const set = (wx, wy, wz, id) => {
        const ch = chunks.get(key(Math.floor(wx / CS), CY, Math.floor(wz / CS)));
        ch.voxels[((wy - CY * CS) * CS + (wz - ch.cz * CS)) * CS + (wx - ch.cx * CS)] = id;
    };
    for (let y = base; y < base + 5; y++) for (let z = 20; z < 25; z++) for (let x = 20; x < 25; x++) set(x, y, z, AIR);
    for (let y = base - 1; y < base + 6; y++) for (let z = 19; z < 26; z++) for (let x = 19; x < 26; x++)
        if (y === base - 1 || y === base + 5 || z === 19 || z === 25 || x === 19 || x === 25) set(x, y, z, STONE);
    for (let y = base; y < base + 5; y++) for (let z = 20; z < 25; z++) for (let x = 20; x < 25; x++) L.relightEdit(x, y, z, AIR);
    settle();

    const before = remesh(1, CY, 1);
    const bl = new Uint8Array(before.lit);
    let maxBlkBefore = 0;
    for (let i = 1; i < bl.length; i += 2) maxBlkBefore = Math.max(maxBlkBefore, bl[i]);
    check('the sealed pocket is dark before the torch goes in', maxBlkBefore === 0, 'max block light ' + maxBlkBefore);

    set(22, base, 22, TORCH);
    L.relightEdit(22, base, 22, TORCH);
    settle();
    check('torch reaches level 14 at the source', L.getBlk(22, base, 22) === 14, 'got ' + L.getBlk(22, base, 22));
    check('torch lights the far pocket wall', L.getBlk(20, base, 20) >= 10, 'got ' + L.getBlk(20, base, 20));

    const after = remesh(1, CY, 1);
    const al = new Uint8Array(after.lit);
    let maxBlk = 0, litVerts = 0;
    for (let i = 1; i < al.length; i += 2) { maxBlk = Math.max(maxBlk, al[i]); if (al[i] > 100) litVerts++; }
    check('the torch shows up as block light in the baked vertex buffer', maxBlk > 200, 'max ' + maxBlk + '/255');
    check('and it lights a whole neighbourhood of vertices, not one face',
        litVerts > 40, litVerts + ' vertices above half brightness');
    // Natural caves can carry real skylight this far down, so "no skylight anywhere in
    // the chunk" would be the wrong assertion. What must hold is that lighting a torch
    // changed only the block channel and left the sky field untouched.
    let skyChanged = 0;
    for (let y = base - 1; y < base + 6; y++) for (let z = 19; z < 26; z++) for (let x = 19; x < 26; x++)
        if (L.getSky(x, y, z) !== 0) skyChanged++;
    check('lighting a torch adds no skylight anywhere in the sealed pocket', skyChanged === 0,
        skyChanged + ' voxels gained sky');
    check('block light in the pocket comes from the torch alone',
        L.getSky(22, base, 22) === 0 && L.getBlk(22, base, 22) === 14);
    // The torch sprite is self-lit via the block channel, NOT by faking skylight, so
    // underground its own vertices must carry zero sky and full block light.
    const torchVerts = [];
    for (let i = 0; i < al.length; i += 2) if (al[i + 1] === 255) torchVerts.push(al[i]);
    check('the torch sprite is emitted and is fully self-lit', torchVerts.length >= 20,
        torchVerts.length + ' torch vertices');
    check('the torch sprite carries no fake skylight underground',
        torchVerts.every(v => v === 0), 'max sky on torch verts ' + Math.max(0, ...torchVerts));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
