// Tests for world feel: terrain shape, cave containment, ground cover and the
// animated torch. These exist because each one is a bug that was actually reported
// in play — "it's a rollercoaster", "caves break the surface everywhere", "pig legs
// go through the ground" — so they assert on statistics a player would notice, not
// on implementation details.
// Run: node world-test.mjs
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

const CS = 16, WORLD_H = 112, SEED = 1337;
const AIR = 0, GRASS = 1, SNOW = 5, LOG = 7, LEAVES = 8;
const PLANTS = new Set([25, 26, 27]);

// ---- boot the worker, plus a test-only hook onto the terrain functions -------
let received = null;
const sb = { self: { postMessage: m => { received = m; } }, performance, console };
vm.createContext(sb);
vm.runInContext(html.match(/\/\*__WORKER_SRC_BEGIN__\*\/([\s\S]*?)\/\*__WORKER_SRC_END__\*\//)[1]
    .replace('self.onmessage = function (e) {',
             'self.__terrain = { heightAt, noiseFor, caveAt, density };\nself.onmessage = function (e) {')
    + '\nworkerMain.call(self);', sb);
const run = m => { received = null; sb.self.onmessage({ data: m }); return received; };
const T = sb.self.__terrain;

// ---- 1. terrain shape: mostly walkable, but with real mountains -------------
{
    const n = T.noiseFor(SEED);
    const H = [];
    for (let x = -2400; x < 2400; x += 4) for (let z = -2400; z < 2400; z += 4) H.push(T.heightAt(n, x, z));
    H.sort((a, b) => a - b);
    const frac = f => H.filter(f).length / H.length;
    const med = H[H.length >> 1];
    check('most of the world is low, walkable ground', frac(h => h < 50) > 0.6 && frac(h => h < 50) < 0.95,
        (100 * frac(h => h < 50)).toFixed(1) + '% below y50');
    check('median ground sits in the plains band', med > 36 && med < 50, 'median y' + med.toFixed(1));
    check('hills exist between the plains and the peaks', frac(h => h >= 50 && h < 70) > 0.05,
        (100 * frac(h => h >= 50 && h < 70)).toFixed(1) + '%');
    check('mountains are findable but not everywhere', frac(h => h >= 70) > 0.01 && frac(h => h >= 70) < 0.25,
        (100 * frac(h => h >= 70)).toFixed(2) + '% above y70');
    check('the tallest peaks reach the snow line', H[H.length - 1] > 90, 'max y' + H[H.length - 1].toFixed(0));

    // local roughness: how much does the ground move between adjacent blocks?
    let steps = [], big = 0;
    for (let x = 0; x < 900; x++) {
        const a = T.heightAt(n, x, 500), b = T.heightAt(n, x + 1, 500);
        const d = Math.abs(a - b);
        steps.push(d);
        if (d > 1) big++;
    }
    const meanStep = steps.reduce((s, v) => s + v, 0) / steps.length;
    check('walking in a straight line is mostly smooth, not a rollercoaster',
        meanStep < 0.75, 'mean step ' + meanStep.toFixed(2) + ' blocks');
    check('and rarely needs more than a single-block hop',
        big / steps.length < 0.2, (100 * big / steps.length).toFixed(1) + '% of steps > 1 block');
}

// ---- 2. generate a patch and inspect the actual voxels -----------------------
const vox = new Map();
const R = 4;
for (let cx = -R; cx <= R; cx++) for (let cz = -R; cz <= R; cz++) for (let cy = 0; cy < 7; cy++)
    vox.set(cx + ',' + cy + ',' + cz, new Uint8Array(run({ type: 'generate', cx, cy, cz, seed: SEED }).voxels));
const at = (wx, wy, wz) => {
    if (wy < 0 || wy >= WORLD_H) return 0;
    const cx = Math.floor(wx / CS), cy = Math.floor(wy / CS), cz = Math.floor(wz / CS);
    const v = vox.get(cx + ',' + cy + ',' + cz);
    return v ? v[((wy - cy * CS) * CS + (wz - cz * CS)) * CS + (wx - cx * CS)] : 0;
};
// topmost block that is actual ground (ignore trees and the plants on top of it)
const groundTop = (wx, wz) => {
    for (let wy = WORLD_H - 1; wy >= 0; wy--) {
        const b = at(wx, wy, wz);
        if (b > 0 && b !== LOG && b !== LEAVES && !PLANTS.has(b)) return wy;
    }
    return -1;
};

// ---- 3. caves stay underground ----------------------------------------------
{
    let breach = 0, deep = 0, cols = 0, air = 0, solid = 0;
    for (let wx = -R * CS; wx < R * CS; wx++) for (let wz = -R * CS; wz < R * CS; wz++) {
        const top = groundTop(wx, wz);
        if (top < 6) continue;
        cols++;
        for (let d = 1; d <= 3; d++) if (at(wx, top - d, wz) === AIR) { breach++; break; }
        for (let d = 6; d <= 14; d++) if (at(wx, top - d, wz) === AIR) { deep++; break; }
        for (let wy = 1; wy < top; wy++) (at(wx, wy, wz) === AIR ? air++ : solid++);
    }
    check('caves never eat through the surface skin', breach === 0,
        breach + ' of ' + cols + ' columns breached');
    check('but caves are still there once you dig', deep / cols > 0.03,
        (100 * deep / cols).toFixed(1) + '% of columns hit a cave 6-14 deep');
    check('underground is hollowed out, not swiss cheese',
        air / (air + solid) > 0.02 && air / (air + solid) < 0.20,
        (100 * air / (air + solid)).toFixed(1) + '% air below ground');
}

// ---- 4. ground cover is placed legally --------------------------------------
{
    let plants = 0, onGrass = 0, clearAbove = 0, buried = 0, cols = 0, withPlant = 0;
    for (let wx = -R * CS; wx < R * CS; wx++) for (let wz = -R * CS; wz < R * CS; wz++) {
        cols++;
        let found = false;
        for (let wy = 1; wy < WORLD_H; wy++) {
            const b = at(wx, wy, wz);
            if (!PLANTS.has(b)) continue;
            plants++; found = true;
            if (at(wx, wy - 1, wz) === GRASS) onGrass++;          // must stand on grass
            if (at(wx, wy + 1, wz) === AIR) clearAbove++;         // must not be buried
            if (at(wx, wy + 1, wz) === LEAVES) buried++;
        }
        if (found) withPlant++;
    }
    check('ground cover was generated', plants > 200, plants + ' plants in the patch');
    check('every plant stands on a grass block', plants > 0 && onGrass === plants,
        onGrass + '/' + plants);
    check('no plant is buried inside anything', plants > 0 && clearAbove === plants,
        clearAbove + '/' + plants + ' have air above');
    check('none spawned under a tree canopy', buried === 0);
    const cover = withPlant / cols;
    check('coverage is decorative, not a lawn you cannot see through',
        cover > 0.02 && cover < 0.35, (100 * cover).toFixed(1) + '% of columns');
}

// ---- 5. plants must not occlude, or the world fills with holes ---------------
{
    // Mesh a chunk twice: once as generated, once with every plant removed. Plants are
    // non-occluding, so stripping them must not reveal any NEW ground faces — if it
    // does, a plant was hiding the block face behind it.
    const PS = 18;
    const build = (cx, cy, cz, strip) => {
        const padded = new Uint8Array(PS * PS * PS), plight = new Uint8Array(PS * PS * PS).fill(0xF0);
        const x0 = cx * CS - 1, y0 = cy * CS - 1, z0 = cz * CS - 1;
        for (let py = 0; py < PS; py++) for (let pz = 0; pz < PS; pz++) for (let px = 0; px < PS; px++) {
            let b = at(x0 + px, y0 + py, z0 + pz);
            if (strip && PLANTS.has(b)) b = AIR;
            padded[(py * PS + pz) * PS + px] = b;
        }
        return run({ type: 'remesh', cx, cy, cz, rev: 1, padded: padded.buffer, plight: plight.buffer });
    };
    // count quads that lie on a given axis-aligned plane, ignoring the plant sprites
    // themselves (their normals are diagonal, never axis-aligned)
    const axisQuads = res => {
        const nrm = new Int8Array(res.normal);
        let n = 0;
        for (let q = 0; q < nrm.length / 12; q++) {
            const nx = nrm[q * 12], ny = nrm[q * 12 + 1], nz = nrm[q * 12 + 2];
            if (Math.abs(nx) === 127 || Math.abs(ny) === 127 || Math.abs(nz) === 127) n++;
        }
        return n;
    };
    let sameEverywhere = true, checked = 0, plantsSeen = 0;
    for (let cy = 2; cy < 5; cy++) {
        const withP = build(0, cy, 0, false), without = build(0, cy, 0, true);
        if (axisQuads(withP) !== axisQuads(without)) sameEverywhere = false;
        if (new Uint8Array(withP.normal).length > new Uint8Array(without.normal).length) plantsSeen++;
        checked++;
    }
    check('plants do not occlude the blocks behind them', sameEverywhere,
        checked + ' chunks compared');
    check('and they really are adding geometry of their own', plantsSeen > 0);
}

// ---- 6. the torch flame actually animates -----------------------------------
{
    const src = fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8');
    const px = [];
    const mkCanvas = () => {
        const buf = [];
        const ctx = {
            fillStyle: '', imageSmoothingEnabled: false,
            fillRect(x, y, w, h) { buf.push(x + ',' + y + ',' + this.fillStyle); },
            clearRect() { buf.length = 0; }, drawImage() {}
        };
        return { width: 16, height: 16, getContext: () => ctx, toDataURL: () => '', __buf: buf };
    };
    const gs = { console, Math, btoa, atob, setInterval, clearInterval, setTimeout, clearTimeout,
                 Image: class { set src(v) {} },
                 document: { createElement: () => mkCanvas() } };
    vm.createContext(gs);
    vm.runInContext(src, gs);
    const TexGen = vm.runInContext('TexGen', gs);
    check('torch is registered as an animated tile', TexGen.ANIMATED.includes('torch'));
    const frames = [0, 1, 2, 3].map(f => {
        const c = mkCanvas();
        TexGen.drawTile('torch', c.getContext('2d'), 0, 0, f);
        return c.__buf.join('|');
    });
    check('all four flame frames differ from one another',
        new Set(frames).size === 4, new Set(frames).size + ' distinct frames');
    check('the frame index wraps instead of going blank', (() => {
        const c = mkCanvas();
        TexGen.drawTile('torch', c.getContext('2d'), 0, 0, 4);
        return c.__buf.join('|') === frames[0];
    })());
    check('drawTile refuses tiles it does not know', TexGen.drawTile('nope', mkCanvas().getContext('2d'), 0, 0, 0) === false);
}

// ---- 7. guard: limb geometry must never be mutated in place -----------------
{
    // boxOf() returns a SHARED BufferGeometry. Calling .translate() on it moved every
    // limb that had ever used that size, which is why mob legs sank further through
    // the floor with each spawn. Keep it impossible to reintroduce.
    check('mob limbs never call geometry.translate on a shared box',
        !/boxOf\([^)]*\)[^;]*;\s*\n\s*\w+\.geometry\.translate/.test(html) &&
        !/const (leg|arm) = new THREE\.Mesh\(boxOf[\s\S]{0,80}?\.geometry\.translate/.test(html));
    check('limbs hang from a pivot group instead', /function limb\(/.test(html));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
