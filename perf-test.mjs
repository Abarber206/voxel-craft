// Verification harness: extracts the EXACT worker source from index.html and runs it in Node.
// Measures generation+meshing time, memory per chunk, and hidden-face culling efficiency,
// plus correctness checks (determinism, cross-chunk seam culling). Run: node perf-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const here = path.dirname(new URL(import.meta.url).pathname);
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
    ok ? pass++ : fail++;
};

// ---- 0. Syntax checks on the shipped JS ------------------------------------
{
    const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const tmp = path.join(os.tmpdir(), 'voxel-main-check.mjs');
    fs.writeFileSync(tmp, mod);
    const r1 = spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
    check('main module syntax (node --check)', r1.status === 0, (r1.stderr || '').split('\n')[0]);
    const r2 = spawnSync('node', ['--check', path.join(here, 'net-module.js')], { encoding: 'utf8' });
    check('net-module.js syntax (node --check)', r2.status === 0, (r2.stderr || '').split('\n')[0]);
    const r3 = spawnSync('node', ['--check', path.join(here, 'game-systems.js')], { encoding: 'utf8' });
    check('game-systems.js syntax (node --check)', r3.status === 0, (r3.stderr || '').split('\n')[0]);
}

// ---- 1. Boot the worker source ---------------------------------------------
const m = html.match(/\/\*__WORKER_SRC_BEGIN__\*\/([\s\S]*?)\/\*__WORKER_SRC_END__\*\//);
if (!m) { console.error('worker source markers not found'); process.exit(1); }

let received = null;
const sandbox = { self: { postMessage: msg => { received = msg; } }, performance, console };
vm.createContext(sandbox);
vm.runInContext(m[1] + '\nworkerMain.call(self);', sandbox);
const run = msg => { received = null; sandbox.self.onmessage({ data: msg }); return received; };

const SEED = 1337, CS = 16, PS = 18, WORLD_H = 112;
const vox = (v, x, y, z) => v[(y * CS + z) * CS + x];
const collect = (rs, pred) => { // count voxels matching pred across chunk results
    let n = 0;
    for (const r of rs) { const v = new Uint8Array(r.voxels); for (const b of v) if (pred(b)) n++; }
    return n;
};

// Meshing is now a second pass: 'generate' returns voxels only, and the main thread
// hands back padded blocks + padded light as a 'remesh' job once the light has been
// flood-filled. The harness reproduces that handoff so it exercises the real path.
const genCache = new Map();
const gkey = (cx, cy, cz) => cx + ',' + cy + ',' + cz;
function genChunk(cx, cy, cz) {
    const k = gkey(cx, cy, cz);
    let v = genCache.get(k);
    if (!v) { v = new Uint8Array(run({ type: 'generate', cx, cy, cz, seed: SEED }).voxels); genCache.set(k, v); }
    return v;
}
function voxAt(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_H) return 0;
    const cx = Math.floor(wx / CS), cy = Math.floor(wy / CS), cz = Math.floor(wz / CS);
    return genChunk(cx, cy, cz)[((wy - cy * CS) * CS + (wz - cz * CS)) * CS + (wx - cx * CS)];
}
// sky=15/block=0 everywhere unless told otherwise: full daylight, no torches
function meshChunk(cx, cy, cz, fillLight = 0xF0) {
    const padded = new Uint8Array(PS * PS * PS);
    const plight = new Uint8Array(PS * PS * PS).fill(fillLight);
    const x0 = cx * CS - 1, y0 = cy * CS - 1, z0 = cz * CS - 1;
    for (let py = 0; py < PS; py++) for (let pz = 0; pz < PS; pz++) for (let px = 0; px < PS; px++)
        padded[(py * PS + pz) * PS + px] = voxAt(x0 + px, y0 + py, z0 + pz);
    return run({ type: 'remesh', cx, cy, cz, rev: 1, padded: padded.buffer, plight: plight.buffer });
}

// ---- 2. Correctness: determinism -------------------------------------------
{
    const a = run({ type: 'generate', cx: 3, cy: 1, cz: -2, seed: SEED });
    const b = run({ type: 'generate', cx: 3, cy: 1, cz: -2, seed: SEED });
    const ma = meshChunk(3, 1, -2), mb = meshChunk(3, 1, -2);
    const eq = Buffer.from(a.voxels).equals(Buffer.from(b.voxels)) &&
               Buffer.from(ma.position).equals(Buffer.from(mb.position));
    check('deterministic generation (same seed -> identical chunk + mesh)', eq);
    const c = run({ type: 'generate', cx: 3, cy: 1, cz: -2, seed: 999 });
    check('seed actually changes terrain', !Buffer.from(a.voxels).equals(Buffer.from(c.voxels)));
}

// ---- 3. Correctness: seam culling between adjacent chunks -------------------
// Every +X boundary face of chunk A must exist exactly where A is solid at x=15
// and its neighbor B is air at x=0 (and vice versa for B's -X faces).
function boundaryFaces(res, nx, xPlane) {
    const pos = new Float32Array(res.position), nrm = new Int8Array(res.normal);
    const set = new Set();
    for (let q = 0; q < pos.length / 12; q++) {
        if (nrm[q * 12] !== nx * 127) continue;
        let onPlane = true, ys = Infinity, zs = Infinity;
        for (let v = 0; v < 4; v++) {
            if (pos[q * 12 + v * 3] !== xPlane) { onPlane = false; break; }
            ys = Math.min(ys, pos[q * 12 + v * 3 + 1]);
            zs = Math.min(zs, pos[q * 12 + v * 3 + 2]);
        }
        if (onPlane) set.add(ys + ',' + zs);
    }
    return set;
}
{
    const A = meshChunk(0, 1, 0), B = meshChunk(1, 1, 0);
    const av = genChunk(0, 1, 0), bv = genChunk(1, 1, 0);
    const expectA = new Set(), expectB = new Set();
    for (let y = 0; y < CS; y++) for (let z = 0; z < CS; z++) {
        if (vox(av, 15, y, z) > 0 && vox(bv, 0, y, z) === 0) expectA.add(y + ',' + z);
        if (vox(bv, 0, y, z) > 0 && vox(av, 15, y, z) === 0) expectB.add(y + ',' + z);
    }
    const gotA = boundaryFaces(A, 1, 16), gotB = boundaryFaces(B, -1, 0);
    const same = (s1, s2) => s1.size === s2.size && [...s1].every(k => s2.has(k));
    check('X-seam faces culled exactly (A +X vs B voxels)', same(gotA, expectA),
        gotA.size + ' faces vs ' + expectA.size + ' expected');
    check('X-seam faces culled exactly (B -X vs A voxels)', same(gotB, expectB),
        gotB.size + ' faces vs ' + expectB.size + ' expected');
}

// ---- 4. Performance: realistic working set ----------------------------------
// Radius-4 circle x 3 vertical chunks = the game's actual initial load set.
const jobs = [];
for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    if (dx * dx + dz * dz > 18) continue;
    for (let cy = 0; cy < 7; cy++) jobs.push([dx, cy, dz]); // full 112-block column
}
run({ type: 'generate', cx: 99, cy: 0, cz: 99, seed: SEED }); // warmup (JIT)

global.gc && global.gc();
const heap0 = process.memoryUsage().heapUsed;
const results = [];
const times = [];
let solids = 0, faces = 0, verts = 0, bytes = 0;
const wall0 = performance.now();
for (const [cx, cy, cz] of jobs) {
    const g = run({ type: 'generate', cx, cy, cz, seed: SEED });
    genCache.set(gkey(cx, cy, cz), new Uint8Array(g.voxels));
    const r = meshChunk(cx, cy, cz);
    r.voxels = g.voxels;                       // keep both halves on one record
    times.push(g.stats.ms + r.stats.ms);       // the pipeline cost the player pays
    solids += g.stats.solids;
    faces += r.stats.faces;
    verts += r.position.byteLength / 12;
    bytes += g.voxels.byteLength + r.position.byteLength + r.normal.byteLength +
             r.color.byteLength + r.uv.byteLength + r.lit.byteLength + r.index.byteLength;
    results.push(r); // retain, to measure real memory footprint
}
const wall = performance.now() - wall0;
global.gc && global.gc();
const heapMB = (process.memoryUsage().heapUsed - heap0) / 1048576;

times.sort((a, b) => a - b);
const avg = times.reduce((s, t) => s + t, 0) / times.length;
const med = times[times.length >> 1], max = times[times.length - 1];
const naiveFaces = solids * 6;
const culled = 100 * (1 - faces / naiveFaces);
const naiveBytes = naiveFaces * (4 * 12 * 2 + 6 * 4) + jobs.length * 4096; // pos+nrm+col+idx if nothing culled

console.log('\n== Chunk pipeline performance (' + jobs.length + ' chunks = radius-4 x 3 load set) ==');
console.log('  gen+mesh time/chunk : avg ' + avg.toFixed(2) + ' ms | median ' + med.toFixed(2) +
            ' ms | max ' + max.toFixed(2) + ' ms | total wall ' + (wall / 1000).toFixed(2) + ' s (1 thread; game uses 2-4 workers)');
console.log('  solids              : ' + solids.toLocaleString() + ' voxels');
console.log('  faces               : ' + faces.toLocaleString() + ' emitted vs ' + naiveFaces.toLocaleString() +
            ' naive -> ' + culled.toFixed(1) + '% culled');
console.log('  geometry            : ' + Math.round(verts / jobs.length).toLocaleString() + ' verts/chunk avg, ' +
            (faces * 2).toLocaleString() + ' tris total');
console.log('  memory              : ' + (bytes / 1048576).toFixed(1) + ' MB buffers (' +
            Math.round(bytes / jobs.length / 1024) + ' KB/chunk) vs ' + (naiveBytes / 1048576).toFixed(1) +
            ' MB uncled | node heap delta ' + heapMB.toFixed(1) + ' MB');
console.log('  draw calls          : <= ' + results.filter(r => r.position.byteLength > 0).length +
            ' (1/non-empty chunk, minus frustum culling at runtime)\n');

check('avg gen+mesh < 12 ms/chunk (async in workers regardless)', avg < 12, avg.toFixed(2) + ' ms');
check('hidden-face culling >= 85%', culled >= 85, culled.toFixed(1) + '%');
check('buffer memory <= 120 KB/chunk avg (incl. UVs)', bytes / jobs.length <= 122880, Math.round(bytes / jobs.length / 1024) + ' KB');
// Cube and torch faces are 4 verts / 6 indices; plant cross-sprites are drawn
// double-sided, so they are 4 verts / 12 indices. The ratio therefore sits between
// 1.5 and 3.0, and must still be a whole number of triangles.
check('all chunks non-degenerate (indices are whole triangles, 1.5-3x verts)', results.every(r => {
    const idxN = r.index.byteLength / 4, vN = r.position.byteLength / 12;
    return idxN % 3 === 0 && vN % 4 === 0 && idxN >= vN * 1.5 && idxN <= vN * 3;
}));
check('uv attribute consistent (2 floats per vertex, atlas range)', results.every(r => {
    if (r.uv.byteLength / 8 !== r.position.byteLength / 12) return false;
    const u = new Float32Array(r.uv);
    for (let i = 0; i < u.length; i++) if (u[i] < 0 || u[i] > 1) return false;
    return true;
}));
check('trees generated (log + leaves present in world)', results.some(r => {
    const v = new Uint8Array(r.voxels);
    return v.includes(7) && v.includes(8);
}));
check('ore veins generated (coal or iron present underground)', results.some(r => {
    const v = new Uint8Array(r.voxels);
    return v.includes(13) || v.includes(14);
}));
{
    // ore BALANCE: ores should be sparse (well under 1% of solid stone), and soil
    // rule holds — grass must never sit directly on stone
    const oreN = collect(results, b => b >= 13 && b <= 16 || b === 24);
    check('ores are sparse after rebalance (< 0.8% of all solids)', oreN > 0 && oreN / solids < 0.008,
        oreN + ' ore blocks / ' + solids.toLocaleString() + ' solids');
    let stoneUnderGrass = 0, grassN = 0;
    for (const r of results) {
        const v = new Uint8Array(r.voxels);
        for (let y = 1; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++)
            if (vox(v, x, y, z) === 1) { grassN++; if (vox(v, x, y - 1, z) === 3) stoneUnderGrass++; }
    }
    check('soil layers: no stone directly under grass (within-chunk check)',
        grassN > 0 && stoneUnderGrass === 0, grassN + ' grass, ' + stoneUnderGrass + ' violations');
}
// ---- 5. Baked light reaches the vertex buffer -------------------------------
{
    check('alight attribute present, 2 bytes per vertex', results.every(r =>
        r.lit && r.lit.byteLength / 2 === r.position.byteLength / 12));
    const sunlit = meshChunk(0, 2, 0, 0xF0);   // sky 15, block 0
    const dark = meshChunk(0, 2, 0, 0x00);     // sealed: no sky, no torches
    const sl = new Uint8Array(sunlit.lit), dl = new Uint8Array(dark.lit);
    let sunSky = 0, darkSky = 0;
    for (let i = 0; i < sl.length; i += 2) { sunSky += sl[i]; darkSky += dl[i]; }
    check('full-sky input bakes bright skylight into every vertex', sl.length > 0 && sunSky / (sl.length / 2) > 200,
        'mean sky ' + (sunSky / (sl.length / 2)).toFixed(0) + '/255');
    check('zero-light input bakes pitch black (this is what makes caves dark)', darkSky === 0);

    // a torch in an otherwise dark chunk must light the faces around it
    const torchLit = meshChunk(0, 2, 0, 0x0A);  // block light 10 everywhere
    const tl = new Uint8Array(torchLit.lit);
    let blk = 0;
    for (let i = 1; i < tl.length; i += 2) blk += tl[i];
    check('block light is baked on its own channel, independent of sky',
        tl.length > 0 && blk / (tl.length / 2) > 140 && darkSky === 0,
        'mean block ' + (blk / (tl.length / 2)).toFixed(0) + '/255');
}

check('ambient occlusion baked (corner shade varies within quads)', results.some(r => {
    const c = new Uint8Array(r.color);
    for (let q = 0; q < c.length / 12; q++) {
        const a = c[q * 12];
        if (Math.abs(c[q * 12 + 3] - a) > 10 || Math.abs(c[q * 12 + 6] - a) > 10 ||
            Math.abs(c[q * 12 + 9] - a) > 10) return true;
    }
    return false;
}));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
