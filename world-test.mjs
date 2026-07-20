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
const BIRCH_LOG = 39, BIRCH_LEAVES = 40;
const TREE = new Set([LOG, LEAVES, BIRCH_LOG, BIRCH_LEAVES]);
const PLANTS = new Set([25, 26, 27, 28, 29, 30, 31, 32, 33, 34]);

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
        if (b > 0 && !TREE.has(b) && !PLANTS.has(b)) return wy;
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

// ---- 8. mobs must actually clear a one-block step ---------------------------
{
    // Apex of a jump is v^2/2g. The reported bug was mobs getting stuck on single
    // blocks: the old 7.4 gave 1.014 blocks, which a discrete timestep rounds away.
    const num = re => { const m = re.exec(html); return m ? parseFloat(m[1]) : NaN; };
    const GRAV = num(/const GRAV = ([\d.]+)/);
    const MOB_JUMPV = num(/const MOB_JUMPV = ([\d.]+)/);
    const JUMPV = num(/JUMPV = ([\d.]+)/);
    check('mob jump constant is defined', Number.isFinite(MOB_JUMPV) && Number.isFinite(GRAV));
    const apex = (MOB_JUMPV * MOB_JUMPV) / (2 * GRAV);
    check('a mob jump clears a full block with margin', apex >= 1.15,
        apex.toFixed(3) + ' blocks');
    check('but not so high they hop over walls', apex < 2, apex.toFixed(3) + ' blocks');
    check('players still jump at least as high as mobs',
        (JUMPV * JUMPV) / (2 * GRAV) >= apex);
    // simulate the real fixed step to be sure discretisation doesn't eat it
    let y = 0, v = MOB_JUMPV, peak = 0;
    for (let i = 0; i < 200; i++) { v -= GRAV * (1 / 60); y += v * (1 / 60); peak = Math.max(peak, y); if (y < 0) break; }
    check('and it still clears a block when stepped at 60Hz', peak >= 1.05, peak.toFixed(3) + ' blocks');
}

// ---- 9. mouse look must not be at the mercy of OS acceleration --------------
{
    check('pointer lock asks for unadjusted movement', /unadjustedMovement:\s*true/.test(html));
    // The fallback must NOT retry inside the rejection handler: that runs outside the
    // user gesture, so the retry is refused and the pointer never locks at all.
    check('an unsupported option degrades to a plain lock on the next click',
        /rawMouseOK = false/.test(html) && /rawMouseOK \?/.test(html));
    check('re-locking is rate limited so it cannot thrash', /lockCooldown/.test(html));
    check('look deltas are normalised by device pixel ratio', /devicePixelRatio/.test(html));
    check('a single event cannot spin the view wildly', /Math\.min\(600,\s*Math\.abs|Math\.min\(600/.test(html));
    const m = /id="setSens"[^>]*min="(\d+)"/.exec(html);
    check('sensitivity can be turned genuinely low', m && +m[1] <= 10, m ? 'min ' + m[1] : 'not found');
}

// ---- 10. invite links -------------------------------------------------------
{
    // Reproduce the shipped parser so the accepted formats are pinned down.
    const src = /function parseCode\(raw\) \{[\s\S]*?\n        \}/.exec(html);
    check('parseCode exists', !!src);
    const parseCode = new Function('raw', src[0].replace(/^function parseCode\(raw\) \{/, '') .replace(/\}$/, ''));
    const cases = [
        ['abc12', 'abc12'], ['ABC12', 'abc12'], ['  abc12  ', 'abc12'],
        ['voxel-abc12', 'abc12'], ['VOXEL-ABC12', 'abc12'],
        ['https://abarber206.github.io/voxel-craft/?join=abc12', 'abc12'],
        ['https://example.com/game?x=1&join=ABC12#frag', 'abc12']
    ];
    let ok = 0;
    for (const [input, want] of cases) { if (parseCode(input) === want) ok++; else console.log('        ' + JSON.stringify(input) + ' -> ' + parseCode(input) + ' (wanted ' + want + ')'); }
    check('codes, prefixed codes and full invite links all parse', ok === cases.length, ok + '/' + cases.length);
    check('an invite in the URL is honoured', /searchParams|[?&#]join=/.test(html) && /urlJoin/.test(html));
    check('there is a one-click copy for the invite', /clipboard\.writeText/.test(html));
}

// ---- 11. dropped items ------------------------------------------------------
{
    check('mined blocks spawn a pickup instead of teleporting into the bag',
        /spawnDrop\(itemId, 1, hit\.x/.test(html));
    check('mob kills drop loot on the ground too', /spawnDrop\(m\.def\.drop/.test(html));
    check('drops merge into nearby piles rather than stacking up entities',
        /DROP_MERGE_R/.test(html));
    check('drops expire so a long session cannot leak entities', /DROP_LIFE/.test(html));
    check('a fresh drop cannot be re-collected instantly', /arm:/.test(html) && /d\.arm > 0/.test(html));
    check('a full inventory leaves the item lying instead of destroying it',
        /left === d\.n\) break/.test(html));
    check('drops and pickups are broadcast to peers',
        /sendDrop/.test(html) && /sendPickup/.test(html));
}

// ---- 12. split-screen and mouse-free play -----------------------------------
{
    check('there is a hand rig per local player', /handRigs\s*=\s*\[makeHandRig\(0\), makeHandRig\(1\)\]/.test(html));
    check('the hand pass is no longer disabled in split mode',
        !/const active = !splitMode/.test(html));
    check('each split viewport draws its own arm layer', /handCamera\.layers\.set\(i \+ 1\)/.test(html));
    check('arm geometry is translated once, not per rig',
        /armForeGeo\.translate/.test(html) && !/armFore\.geometry\.translate/.test(html));
    const gs = fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8');
    check('the inventory has a keyboard/gamepad slot cursor',
        /moveFocus\(dx, dy\)/.test(gs) && /activateFocus\(button, shift\)/.test(gs));
    check('slot navigation is geometric, so it works in every panel layout',
        /getBoundingClientRect/.test(gs));
    check('the inventory always shows a selection box, mouse or pad',
        /invUI\.moveFocus\(1, 0\);   \/\/ always show the selection box/.test(html));
    check('mouse hover drives that same box, so the two never disagree',
        /Mouse hover drives the same highlight/.test(fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8')));
    check('held tools are rolled the opposite way to upright sprites',
        /diagonal \? 0\.22 : -0\.4/.test(html));
}

// ---- 13. world spawn: dying must never leave you stuck ----------------------
{
    // Run the SHIPPED surface test against the real generated world.
    const grab = re => { const m = re.exec(html); return m ? m[0] : null; };
    const srcGround = grab(/const spawnableGround = [^;]+;/);
    const srcSurface = grab(/function surfaceAt\(wx, wz\) \{[\s\S]*?\n        \}/);
    check('spawn helpers exist', !!srcGround && !!srcSurface);
    const ctx2 = { WORLD_H, PLANT_IDS: PLANTS, getBlock: (wx, wy, wz) => {
        if (wy < 0) return 3;
        if (wy >= WORLD_H) return 0;
        const cx = Math.floor(wx / CS), cy = Math.floor(wy / CS), cz = Math.floor(wz / CS);
        const v = vox.get(cx + ',' + cy + ',' + cz);
        return v ? v[((wy - cy * CS) * CS + (wz - cz * CS)) * CS + (wx - cx * CS)] : undefined;
    } };
    vm.createContext(ctx2);
    vm.runInContext(srcGround + '\n' + srcSurface + '\nthis.surfaceAt = surfaceAt; this.spawnableGround = spawnableGround;', ctx2);
    const { surfaceAt, spawnableGround } = ctx2;

    const SPAWN = { x: 8.5, z: 8.5 };
    const RADIUS = +(/const SPAWN_RADIUS = (\d+)/.exec(html) || [])[1];
    check('the world has a spawn radius, not a single block', RADIUS >= 8, 'radius ' + RADIUS);

    let found = 0, tries = 4000, ys = [];
    for (let t = 0; t < tries; t++) {
        for (let att = 0; att < 40; att++) {
            const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * RADIUS;
            const y = surfaceAt(Math.floor(SPAWN.x + Math.cos(a) * r), Math.floor(SPAWN.z + Math.sin(a) * r));
            if (y < 0) continue;
            found++; ys.push(y); break;
        }
    }
    check('a legal spawn is always found inside the radius', found === tries, found + '/' + tries);
    check('spawns are scattered, not all on one block', new Set(ys).size > 2,
        new Set(ys).size + ' distinct ground heights');

    // every accepted spot must genuinely be standable
    let bad = 0, checked = 0;
    for (let t = 0; t < 3000; t++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * RADIUS;
        const wx = Math.floor(SPAWN.x + Math.cos(a) * r), wz = Math.floor(SPAWN.z + Math.sin(a) * r);
        const y = surfaceAt(wx, wz);
        if (y < 0) continue;
        checked++;
        const clear = v => v === 0 || PLANTS.has(v);
        if (!spawnableGround(ctx2.getBlock(wx, y, wz)) ||
            !clear(ctx2.getBlock(wx, y + 1, wz)) || !clear(ctx2.getBlock(wx, y + 2, wz))) bad++;
    }
    check('no spawn lands inside a block or without headroom', checked > 500 && bad === 0,
        bad + ' bad of ' + checked);
    check('spawning ignores where other players are', !/occupiedSpawn/.test(html));
    check('a stuck respawn eventually forces itself through', /spawnWait/.test(html) &&
        /p\.spawnWait < 90/.test(html));
    check('loading a far-away save centres chunk streaming on it first',
        /Chunk streaming is centred on p\.pos/.test(html));
    check('tree blocks are never treated as spawnable ground',
        !spawnableGround(LOG) && !spawnableGround(LEAVES) && spawnableGround(GRASS));
}

// ---- 14. F3 readout ---------------------------------------------------------
{
    check('there is a debug panel per player', /id="dbg1"/.test(html) && /id="dbg2"/.test(html));
    check('F3 toggles it', /e\.code === 'F3'/.test(html));
    check('the second panel docks to the right half in split-screen',
        /#dbg2 \{ left: 50%/.test(html));
    check('it reports coordinates and the other player\'s position',
        /Block ' \+ bx/.test(html) && /P' \+ \(j \+ 1\) \+ ' at /.test(html));
    check('and it refreshes every frame, not on the HUD timer',
        /if \(debugOn\) updateDebug\(\)/.test(html));
}

// ---- 15. mobs shouldn't all be standing on peaks ----------------------------
{
    check('mob spawns reject slopes', /Reject slopes/.test(html) && /surfaceAt\(bx \+ dx, bz \+ dz\)/.test(html));
    check('mob spawns stay near the player\'s altitude',
        /Math\.abs\(y - p\.pos\.y\) > \(kind === 'zombie' \? 16 : 10\)/.test(html));
    check('and it retries enough times to still find somewhere', /att < 24/.test(html));
}

// ---- 16. clouds must actually have pixels in them ---------------------------
{
    // This shipped invisible TWICE because the alpha threshold was tuned by eye against
    // a distribution nobody measured. Run the real generator and assert on coverage.
    const src = /function makeCloudTexture\(\) \{[\s\S]*?\n        \}/.exec(html);
    check('cloud texture generator exists', !!src);
    let alphas = [];
    let rawAlpha = null;
    const ctxStub = {
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: img => { rawAlpha = img.data; for (let i = 3; i < img.data.length; i += 4) alphas.push(img.data[i] / 255); }
    };
    const sandbox = {
        document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }) },
        THREE: { CanvasTexture: class { constructor() { this.wrapS = this.wrapT = 0; this.repeat = { set() {} }; } },
                 RepeatWrapping: 1 },
        Math
    };
    vm.createContext(sandbox);
    vm.runInContext(src[0] + '\nthis.tex = makeCloudTexture();', sandbox);
    alphas.sort((a, b) => a - b);
    const cover = f => alphas.filter(f).length / alphas.length;
    const mean = alphas.reduce((s, v) => s + v, 0) / alphas.length;
    check('the cloud texture is not blank', alphas.length > 1000 && mean > 0.12,
        'mean alpha ' + mean.toFixed(3));
    check('coverage looks like sky, not overcast and not empty',
        cover(a => a > 0.1) > 0.25 && cover(a => a > 0.1) < 0.75,
        (100 * cover(a => a > 0.1)).toFixed(1) + '% of texels visible');
    check('there are solid cloud cores, not just haze', cover(a => a > 0.85) > 0.05,
        (100 * cover(a => a > 0.85)).toFixed(1) + '% opaque');
    check('the dome threshold is stated explicitly', /smoothstep\(0\.30, 0\.30 \+ sharp, a\)/.test(html));
    // The old plane-based clouds failed twice. They now live in the sky dome shader,
    // which demonstrably draws. Simulate cloudLayer() over a hemisphere of view
    // directions and assert the player will actually SEE cloud.
    const sampleA = (u, v) => {
        const S = 256;
        const x = Math.floor((((u % 1) + 1) % 1) * S), y = Math.floor((((v % 1) + 1) % 1) * S);
        return rawAlpha[(y * S + x) * 4 + 3] / 255;
    };
    const ss2 = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    function cloudLayer(dx, dy, dz, height, scale, sharp) {
        if (dy < 0.015) return 0;
        const t = height / dy;
        const u = (dx * t) * scale, v = (dz * t) * scale;
        let a = sampleA(u, v) * 0.60 + sampleA(u * 2.13 + 0.37, v * 2.13 + 0.37) * 0.28
              + sampleA(u * 4.31 - 0.21, v * 4.31 - 0.21) * 0.12;
        a = ss2(0.30, 0.30 + sharp, a);
        a *= 1 - ss2(900, 4200, t);
        a *= ss2(0.015, 0.10, dy);
        return Math.max(0, Math.min(1, a));
    }
    let vis = 0, strong = 0, tot = 0;
    for (let i = 0; i < 12000; i++) {
        const dy = Math.random(), r = Math.sqrt(1 - dy * dy), th = Math.random() * Math.PI * 2;
        const dx = Math.cos(th) * r, dz = Math.sin(th) * r;
        const c = Math.max(cloudLayer(dx, dy, dz, 90, 0.00140, 0.34) * 0.95,
                           cloudLayer(dx, dy, dz, 150, 0.00075, 0.38) * 0.72,
                           cloudLayer(dx, dy, dz, 260, 0.00035, 0.42) * 0.55);
        tot++; if (c > 0.06) vis++; if (c > 0.4) strong++;
    }
    check('a meaningful slice of the sky actually shows cloud',
        vis / tot > 0.12 && vis / tot < 0.75, (100 * vis / tot).toFixed(1) + '% of sky directions');
    check('and some of it is solid, not just faint wisps', strong / tot > 0.05,
        (100 * strong / tot).toFixed(1) + '% strong');
    check('clouds are rendered by the sky dome, not separate planes',
        /float cloudLayer\(vec3 d/.test(html) && !/makeCloudLayer/.test(html));
    check('three decks are composited at different heights',
        /cloudLayer\(d,\s*260/.test(html) && /cloudLayer\(d,\s*150/.test(html) && /cloudLayer\(d,\s*90/.test(html));
}

// ---- 17. this batch's fixes --------------------------------------------------
{
    check('hand camera aspect follows the split viewport',
        /handCamera\.aspect = \(w \/ 2\) \/ hgt/.test(html));
    check('first-person block is no longer oversized', /BoxGeometry\(0\.19, 0\.19, 0\.19\)/.test(html));
    check('leaves no longer occlude, so their gaps show the world',
        /v !== 8 && v !== 40/.test(html));
    check('leaves punch real transparent holes',
        /punchHoles/.test(fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8')));
    check('players carry a real point light when holding a torch',
        /heldLights/.test(html) && /PointLight/.test(html));
    check('and that light is sent to peers so their torches light your world',
        /holdingLight/.test(html) && /remoteLights/.test(html));
    check('avatars are tinted by the voxel light they stand in', /function litAvatar/.test(html));
    check('avatars are articulated with head, arms and legs',
        /function poseAvatar/.test(html) && /legL/.test(html) && /neck/.test(html));
    check('avatars show the item they are holding', /function setAvatarHeld/.test(html));
    check('head follows the look direction over the network', /pitch: \+s\.q/.test(html));
    check('stairs exist with 4 facings and orient to the player',
        /const isStair/.test(html) && /ORIENTED\[placeIdBase/.test(html));
    check('doors are two-tall, oriented and openable',
        /const isDoorLo/.test(html) && /doorOpen/.test(html) && /doorToggle\(loId\)/.test(html));
    check('an open door can be walked through', /isDoor\(b\)\) return !doorOpen\(b\)/.test(html));
    check('breaking one door half removes the other', /isDoorHi\(getBlock\(wx, wy \+ 1, wz\)\)/.test(html));
    check('hurting an animal panics the whole herd', /function panicHerd/.test(html));
    check('there is a dedicated multiplayer screen',
        /id="multi"/.test(html) && /btnMpJoin/.test(html) && /openMultiplayer/.test(html));
    const gs = fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8');
    check('stairs and doors have crafting recipes',
        /'plank_stairs', 4\)/.test(gs) && /'cobble_stairs', 4\)/.test(gs) && /'wooden_door', 3\)/.test(gs));
}

// ---- 18. stairs and doors, end to end ---------------------------------------
{
    // Mesh a single block of each and inspect the geometry that comes out. A stair
    // must be two boxes; a door must be a thin slab, not a full cube.
    const PS = 18;
    const meshOne = id => {
        const padded = new Uint8Array(PS ** 3), plight = new Uint8Array(PS ** 3).fill(0xF0);
        padded[(9 * PS + 9) * PS + 9] = id;
        const r = run({ type: 'remesh', cx: 0, cy: 0, cz: 0, rev: 1, padded: padded.buffer, plight: plight.buffer });
        const p = new Float32Array(r.position);
        if (!p.length) return null;
        const b = { x: [1e9, -1e9], y: [1e9, -1e9], z: [1e9, -1e9] };
        for (let i = 0; i < p.length; i += 3) {
            b.x[0] = Math.min(b.x[0], p[i] - 8); b.x[1] = Math.max(b.x[1], p[i] - 8);
            b.y[0] = Math.min(b.y[0], p[i + 1] - 8); b.y[1] = Math.max(b.y[1], p[i + 1] - 8);
            b.z[0] = Math.min(b.z[0], p[i + 2] - 8); b.z[1] = Math.max(b.z[1], p[i + 2] - 8);
        }
        return { verts: p.length / 3, b };
    };
    const stair = meshOne(41), door = meshOne(49), doorOpen = meshOne(50), cube = meshOne(9);
    check('a stair emits two boxes, not one', stair && stair.verts === cube.verts * 2,
        stair ? stair.verts + ' verts vs ' + cube.verts + ' for a cube' : 'no geometry');
    check('a closed door is a thin slab', door && (door.b.z[1] - door.b.z[0]) < 0.25 &&
        (door.b.x[1] - door.b.x[0]) > 0.9 && (door.b.y[1] - door.b.y[0]) > 0.9,
        door ? 'depth ' + (door.b.z[1] - door.b.z[0]).toFixed(3) : 'no geometry');
    check('an open door swings to the perpendicular wall',
        doorOpen && (doorOpen.b.x[1] - doorOpen.b.x[0]) < 0.25 && (doorOpen.b.z[1] - doorOpen.b.z[0]) > 0.9,
        doorOpen ? 'depth ' + (doorOpen.b.x[1] - doorOpen.b.x[0]).toFixed(3) : 'no geometry');
    check('doors and stairs do not occlude their neighbours',
        /!\(v >= 49 && v <= 64\)/.test(html) && /!\(v >= 41 && v <= 48\)/.test(html));

    // The open/closed toggle must stay inside the door's own id block.
    const DOOR_LO = 49, DOOR_HI = 57;
    const isLo = id => id >= DOOR_LO && id < DOOR_LO + 8;
    const isHi = id => id >= DOOR_HI && id < DOOR_HI + 8;
    const base = id => (isLo(id) ? DOOR_LO : DOOR_HI);
    const toggle = id => base(id) + ((id - base(id)) ^ 1);
    const open = id => ((id - base(id)) & 1) === 1;
    let allGood = true;
    for (const b0 of [DOOR_LO, DOOR_HI]) for (let f = 0; f < 4; f++) {
        const a = b0 + f * 2, t = toggle(a);
        if (base(t) !== b0) allGood = false;                       // stayed in range
        if (open(t) === open(a)) allGood = false;                  // state flipped
        if (((t - b0) >> 1 & 3) !== f) allGood = false;            // facing preserved
        if (toggle(t) !== a) allGood = false;                      // round-trips
    }
    check('every door id toggles in range, flips state and keeps its facing', allGood);
    check('the toggle is not a bare XOR (the bases are odd)', /doorToggle/.test(html) && !/loId \^ 1/.test(html));
    check('doors only swing on the press, not every frame while held',
        /if \(!pressEdge\) return;/.test(html));

    // placement must not throw — a stair used to hit a temporal dead zone and place nothing
    check('placeId is declared before the oriented-block branch assigns it', (() => {
        const fn = /function doPlace\(p, pressEdge\) \{[\s\S]*?\n        \}/.exec(html)[0];
        return fn.indexOf('let placeId') < fn.indexOf('placeId = placeIdBase(');
    })());
    const gs = fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8');
    check('stairs and doors have their own item art, not a plain material square',
        /CUSTOM\.stairs_oak/.test(gs) && /CUSTOM\.door_item/.test(gs) &&
        /'plank_stairs'[^)]*'stairs_oak'/.test(gs) && /'wooden_door'[^)]*'door_item'/.test(gs));
    check('and they are held as that icon rather than a cube',
        /SPRITE_BLOCKS = new Set\(\[[^\]]*41, 45, 49\]\)/.test(html));
}

// ---- 19. panicking animals must not spin ------------------------------------
{
    check('the sidestep direction is committed, not re-rolled every tick',
        /m\.dodge > 0/.test(html) && /m\.dodgeSign/.test(html));
    check('mobs turn toward their heading instead of snapping to it',
        /m\.yaw \+= d2 \* Math\.min\(1, 9 \* dt\)/.test(html));
    check('and the turn takes the short way round', /while \(d2 > Math\.PI\)/.test(html));
}

// ---- 20. collision boxes: stairs climbable, doors a real hitbox --------------
{
    // Physics treated every solid id as a unit cube, so a stair was an unclimbable wall
    // and a door blocked you even when open. Run the SHIPPED collision code.
    const grab = re => { const m = re.exec(html); return m ? m[0] : null; };
    const shapes = grab(/        const FULL_BOX = \[\[0, 0, 0, 1, 1, 1\]\];[\s\S]*?\n        \}\n(?=        \/\/ Does the player)/);
    const collides = grab(/        function playerCollides\(x, y, z\) \{[\s\S]*?\n        \}\n/);
    const move = grab(/        function moveAxis\(p, axis, amt\) \{[\s\S]*?\n        \}\n/);
    check('collision shapes, playerCollides and moveAxis all present', !!shapes && !!collides && !!move);

    const ctx3 = { Math, console };
    vm.createContext(ctx3);
    vm.runInContext(`
        const HW=0.3, PH=1.8, STEP_UP=0.62;
        const STAIR_FLIP=40;
        const isStair=id=>(id>=41&&id<=48)||(id>=81&&id<=88);
        const stairFlipped=id=>id>=81;
        const stairBaseId=id=>stairFlipped(id)?id-STAIR_FLIP:id;
        const DOOR_LO=49,DOOR_HI=57;
        const isDoorLo=id=>id>=49&&id<57,isDoorHi=id=>id>=57&&id<65;
        const isDoor=id=>isDoorLo(id)||isDoorHi(id);
        const doorBase=id=>isDoorLo(id)?DOOR_LO:DOOR_HI;
        const doorOpen=id=>((id-doorBase(id))&1)===1;
        const isAnyTorch=id=>id===23||(id>=35&&id<=38);
        const PLANT_IDS=new Set([25,26,27,28,29,30,31,32,33,34]);
        const world=new Map(); const K=(x,y,z)=>x+','+y+','+z;
        function getBlock(x,y,z){ if(y<1)return 3; return world.has(K(x,y,z))?world.get(K(x,y,z)):0; }
        ` + shapes + collides + move + `
        this.world=world; this.K=K; this.blockBoxes=blockBoxes;
        this.playerCollides=playerCollides; this.moveAxis=moveAxis; this.stairBoxes=stairBoxes;
        this.walk=function(startZ,steps,vz){
            const p={pos:{x:0.5,y:1.0,z:startZ,set(a,b,c){this.x=a;this.y=b;this.z=c;}},
                     vel:{x:0,y:0,z:0},onGround:true,stepTop:-Infinity,flying:false};
            let maxY=p.pos.y;
            for(let i=0;i<steps;i++){
                const dt=1/60; p.vel.z=vz;
                const dz=p.vel.z*dt, preY=p.pos.y, preZ=p.pos.z, grounded=p.onGround;
                p.stepTop=-Infinity;
                moveAxis(p,'z',dz);
                if(grounded&&Math.abs(p.pos.z-(preZ+dz))>1e-6&&
                   p.stepTop>preY+1e-3&&p.stepTop-preY<=STEP_UP){
                    const ny=p.stepTop+0.002;
                    if(!playerCollides(0.5,ny,preZ+dz)){p.pos.set(0.5,ny,preZ+dz);if(p.vel.y<0)p.vel.y=0;}
                }
                p.onGround=false; p.vel.y-=27*dt; moveAxis(p,'y',p.vel.y*dt);
                if(p.onGround)p.vel.y=0;
                if(p.pos.y>maxY)maxY=p.pos.y;
            }
            return {maxY,z:p.pos.z};
        };`, ctx3);

    const setOnly = id => { ctx3.world.clear(); ctx3.world.set(ctx3.K(0, 1, 1), id); };
    setOnly(43);                                   // stair facing +Z, we walk +Z into it
    let r = ctx3.walk(-0.5, 30, 4.6);
    check('you can WALK up a stair without jumping', r.maxY > 1.4, 'peak y ' + r.maxY.toFixed(2));
    setOnly(3);                                    // a whole block must still stop you
    r = ctx3.walk(-0.5, 30, 4.6);
    check('a full block is still a wall you must jump', r.maxY < 1.1 && r.z < 1,
        'peak y ' + r.maxY.toFixed(2) + ' z ' + r.z.toFixed(2));
    ctx3.world.clear();
    ctx3.world.set(ctx3.K(0, 1, 1), 49); ctx3.world.set(ctx3.K(0, 2, 1), 57);
    r = ctx3.walk(-0.5, 140, 4.6);
    check('a closed door blocks you', r.z < 1, 'stopped at z ' + r.z.toFixed(2));
    ctx3.world.clear();
    ctx3.world.set(ctx3.K(0, 1, 1), 50); ctx3.world.set(ctx3.K(0, 2, 1), 58);
    r = ctx3.walk(-0.5, 140, 4.6);
    check('an OPEN door is a slab you walk through, not an invisible cube', r.z > 3,
        'reached z ' + r.z.toFixed(2));
    check('walk-through blocks have no collision box at all',
        ctx3.blockBoxes(0) === null && ctx3.blockBoxes(23) === null && ctx3.blockBoxes(26) === null);

    // Stair facing: the TALL half must sit on the side the stair faces, and the
    // collision boxes must agree with the rendered mesh. These were inverted, which
    // made a placed stair point away from the player.
    const PS = 18;
    let facingOk = true, agreeOk = true;
    for (let f = 0; f < 4; f++) {
        const padded = new Uint8Array(PS ** 3), plight = new Uint8Array(PS ** 3).fill(0xF0);
        padded[(9 * PS + 9) * PS + 9] = 41 + f;
        const res = run({ type: 'remesh', cx: 0, cy: 0, cz: 0, rev: 1, padded: padded.buffer, plight: plight.buffer });
        const p = new Float32Array(res.position);
        // centroid of everything above the half-height line = where the tall half is
        let sx = 0, sz = 0, n = 0;
        for (let i = 0; i < p.length; i += 3) {
            if (p[i + 1] - 8 <= 0.5001) continue;
            sx += p[i] - 8; sz += p[i + 2] - 8; n++;
        }
        const cx = sx / n, cz = sz / n;
        const wantX = f === 1 ? 1 : f === 3 ? -1 : 0;   // 0 -Z, 1 +X, 2 +Z, 3 -X
        const wantZ = f === 2 ? 1 : f === 0 ? -1 : 0;
        if (wantZ < 0 && !(cz < 0.5)) facingOk = false;
        if (wantZ > 0 && !(cz > 0.5)) facingOk = false;
        if (wantX < 0 && !(cx < 0.5)) facingOk = false;
        if (wantX > 0 && !(cx > 0.5)) facingOk = false;
        // collision's upper box must be on the same side as the mesh's tall half
        const up = ctx3.stairBoxes[f][1];
        const bcx = (up[0] + up[3]) / 2, bcz = (up[2] + up[5]) / 2;
        if (Math.sign(bcx - 0.5) !== Math.sign(cx - 0.5) && wantX !== 0) agreeOk = false;
        if (Math.sign(bcz - 0.5) !== Math.sign(cz - 0.5) && wantZ !== 0) agreeOk = false;
    }
    check('a stair rises AWAY from the player who placed it, on all four facings', facingOk);
    check('the stair collision box matches the shape you can see', agreeOk);
}

// ---- 21. mob spawning: lively but capped ------------------------------------
{
    // Run the SHIPPED spawner against a flat lit world and watch the population.
    const src = /        let spawnT = 0;\n        function trySpawnMobs\(dt\) \{[\s\S]*?\n        \}\n/.exec(html);
    check('spawner extracted', !!src);
    const ctx4 = { Math, console };
    vm.createContext(ctx4);
    vm.runInContext(`
        const MOB_CAP={pig:20,zombie:14}, MOB_TOTAL_CAP=28, WORLD_H=112;
        let DAY=true; const sunUp=()=>DAY;
        const worldMode='survival', worldActive=true;
        const mobs=[];
        const players=[{spawned:true,pos:{x:0.5,y:40,z:0.5}}];
        function getBlock(x,y,z){ return y<=39?(y===39?1:3):0; }
        function surfaceAt(){ return 39; }
        function getSky(){ return 15; } function getBlk(){ return 0; }
        function spawnMob(kind){ mobs.push({kind,def:{hostile:kind==='zombie'}}); }
        ` + src[0] + `
        this.mobs=mobs; this.trySpawnMobs=trySpawnMobs;
        this.setDay=v=>{DAY=v;}; this.CAP=MOB_CAP; this.TOTAL=MOB_TOTAL_CAP;
        this.count=()=>{let p=0,z=0;for(const m of mobs)(m.def.hostile?z++:p++);return [p,z];};`, ctx4);

    const run60 = n => { for (let i = 0; i < n; i++) ctx4.trySpawnMobs(1 / 60); };
    ctx4.setDay(true); run60(4000);
    let [dp, dz] = ctx4.count();
    check('daytime fills the world with animals', dp >= 10, dp + ' pigs in 60s');
    check('and no zombies in daylight', dz === 0);

    ctx4.mobs.length = 0; ctx4.setDay(false); run60(4000);
    let [np, nz] = ctx4.count();
    check('pigs STILL spawn at night (they used to stop entirely)', np >= 8,
        np + ' pigs after dark');
    check('zombies come out at night', nz > 0, nz + ' zombies');

    ctx4.mobs.length = 0;
    for (let i = 0; i < 40000; i++) { ctx4.setDay((i % 20000) < 10000); ctx4.trySpawnMobs(1 / 60); }
    const [lp, lz] = ctx4.count();
    check('the pig cap holds over a long session', lp <= ctx4.CAP.pig, lp + ' <= ' + ctx4.CAP.pig);
    check('the zombie cap holds', lz <= ctx4.CAP.zombie, lz + ' <= ' + ctx4.CAP.zombie);
    check('and the total is capped, so it never floods', ctx4.mobs.length <= ctx4.TOTAL,
        ctx4.mobs.length + ' <= ' + ctx4.TOTAL);

    ctx4.mobs.length = 0; ctx4.setDay(true);
    let ticks = 0, hit5 = null;
    while (ticks < 20000 && !hit5) { ctx4.trySpawnMobs(1 / 60); ticks++; if (ctx4.mobs.length >= 5) hit5 = ticks / 60; }
    check('a fresh world populates quickly', hit5 !== null && hit5 < 20,
        hit5 ? hit5.toFixed(1) + 's to 5 mobs' : 'never reached 5');

    check('animals arrive as a herd, not one at a time', /const want = 2 \+ /.test(html));
    check('zombies need actual darkness, not just night', /lightHere > 7/.test(html));
    check('the spawner no longer prefers zombies to the exclusion of pigs',
        !/zoms < wantZom && night/.test(html) && /roomZom > roomPig/.test(html));
}

// ---- 22. spawn eggs ---------------------------------------------------------
{
    const gs = fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8');
    check('pig and zombie spawn eggs exist as items',
        /'egg_pig'[\s\S]{0,120}spawnEgg: 'pig'/.test(gs) &&
        /'egg_zombie'[\s\S]{0,120}spawnEgg: 'zombie'/.test(gs));
    check('they have their own icons', /CUSTOM\.egg_pig/.test(gs) && /CUSTOM\.egg_zombie/.test(gs));
    check('using one spawns that mob', /if \(it && it\.spawnEgg\)/.test(html) &&
        /spawnMob\(it\.spawnEgg/.test(html));
    check('eggs are handled before the block-only gate',
        html.indexOf('it.spawnEgg') < html.indexOf("it.type !== 'Block'"));
    check('eggs respect the mob cap too', /mobs\.length >= MOB_TOTAL_CAP\) \{ toast/.test(html));
    check('and fire once per click, not every frame held', (() => {
        const fn = /function doPlace\(p, pressEdge\) \{[\s\S]*?\n        \}/.exec(html)[0];
        const i = fn.indexOf('it.spawnEgg');
        return fn.slice(i, i + 200).includes('!pressEdge');
    })());
}

// ---- 23. mob models: faces, facing, and draw-call budget --------------------
{
    check('zombie arms swing FORWARD (-Z), not out the back',
        /arm\.rotation\.x = 1\.4/.test(html) && !/arm\.rotation\.x = -1\.4/.test(html));
    check('both mobs have eyes baked into the body mesh',
        /y: 0\.70, z: -0\.79/.test(html) && /y: 1\.72, z: -0\.23/.test(html));
    check('players have eyes and a mouth', /AV\.eyeW/.test(html) && /AV\.mouth/.test(html));

    // Materials and meshes are the per-frame cost, so measure them.
    let matN = 0, meshN = 0, geoN = 0;
    const THREE3 = {
        Group: class { constructor() { this.children = []; this.userData = {}; this.position = { set() {} }; this.rotation = { x: 0, y: 0, z: 0 }; }
            add(...o) { this.children.push(...o); } },
        Mesh: class { constructor(g, m) { meshN++; this.isMesh = true; this.geometry = g; this.material = m; this.userData = {};
            this.position = { set() {}, y: 0 }; this.scale = { set() {} }; this.children = []; } add(o) { this.children.push(o); } },
        BoxGeometry: class { constructor(w, h, d) { geoN++; this.parameters = { width: w, height: h, depth: d }; } },
        BufferGeometry: class { constructor() { geoN++; } setAttribute() {} setIndex() {} computeBoundingSphere() {} },
        Float32BufferAttribute: class {},
        Color: class { constructor() { this.r = 1; this.g = 1; this.b = 1; } clone() { return this; } multiplyScalar() { return this; } },
        MeshLambertMaterial: class { constructor(o) { matN++; this.color = { clone: () => this.color, multiplyScalar: () => this.color };
            this.emissive = { setHex() {}, copy() {} }; Object.assign(this, o); } }
    };
    const grab = re => { const m = re.exec(html); return m ? m[0] : ''; };
    const ctx5 = { THREE: THREE3, scene: { add() {}, remove() {} }, console };
    vm.createContext(ctx5);
    vm.runInContext([
        grab(/        const mobGeo = \{\}[\s\S]*?\n        \}\n/),
        grab(/        function limb\(w, h, d, mat, x, y, z, parts, matKey\) \{[\s\S]*?\n        \}\n/),
        grab(/        const mobMatCache = new Map\(\);[\s\S]*?\n        \}\n(?=        const eyeGeo)/),
        grab(/        const eyeGeo = [^\n]*\n/),
        grab(/        function mergeBoxes\(boxes\) \{[\s\S]*?\n        \}\n/),
        grab(/        const mobBodyCache = new Map\(\);[\s\S]*?\n        \}\n(?=        function buildMobMesh)/),
        grab(/        function buildMobMesh\(kind\) \{[\s\S]*?\n        \}\n/)
    ].join('\n') + '\nthis.buildMobMesh = buildMobMesh;', ctx5);
    matN = meshN = geoN = 0;
    for (let i = 0; i < 20; i++) ctx5.buildMobMesh('pig');
    for (let i = 0; i < 14; i++) ctx5.buildMobMesh('zombie');
    check('a full mob population stays under 200 draw calls', meshN <= 200,
        meshN + ' meshes for 34 mobs (' + (meshN / 34).toFixed(1) + ' each)');
    check('materials are shared per kind, not allocated per mob', matN <= 30,
        matN + ' materials for 34 mobs');
    check('geometry is shared too', geoN <= 12, geoN + ' geometries');
    check('the hurt flash swaps materials instead of mutating a shared colour',
        /function setMobHurt/.test(html) && !/o\.material\.emissive\.setHex\(hurt/.test(html));
    check('removeMob no longer disposes shared materials',
        /Geometry AND materials are shared per kind now/.test(html));
}

// ---- 24. characters, oriented placement, equipment hints --------------------
{
    check('there are selectable characters', /const SKINS = \[/.test(html) && /skinById/.test(html));
    check('the picker is in Settings', /setSkin1/.test(html) && /setSkin2/.test(html));
    check('choosing one rebuilds that avatar', /function applySkin/.test(html));
    check('your character is sent to peers', /s: p\.skinId/.test(html) && /r\.rebuild\[i\] = true/.test(html));
    check('skins are read from storage, not from prefs (which does not exist yet)',
        /function savedSkin/.test(html) && /temporal\s*\n\s*\/\/ dead zone crash on boot/.test(html));

    check('logs remember the axis you laid them on', /const LOG_X = 65/.test(html) &&
        /hit\.face\[0\] !== 0\) placeId = birch \? BIRCH_X : LOG_X/.test(html));
    check('and the mesher rotates their rings to match', /65: \[4, 5, 4\], 66: \[4, 4, 5\]/.test(html));
    check('stairs flip upside down when hung from a ceiling',
        /const upsideDown = hit\.face\[1\] === -1/.test(html) && /placeId \+= STAIR_FLIP/.test(html));
    check('flipped stairs get their own collision boxes', /stairBoxesFlip/.test(html));
    check('every rotated variant still drops the plain item',
        /65: 'log', 66: 'log'/.test(html) && /81: 'plank_stairs'/.test(html));

    const gs = fs.readFileSync(path.join(here, 'game-systems.js'), 'utf8');
    check('empty equipment slots show what belongs in them',
        /CUSTOM\.slot_helmet/.test(gs) && /CUSTOM\.slot_boots/.test(gs) && /CUSTOM\.slot_offhand/.test(gs));
    check('and the hint disappears once the slot is filled',
        /classList\.toggle\('filled'/.test(gs) && /\.slot\.filled img\.ghost/.test(html));
    check('shoulder buttons change the held block', /btn\(15\) \|\| btn\(5\)/.test(html) &&
        /btn\(14\) \|\| btn\(4\)/.test(html));
    check('Y opens and closes the inventory', /yBtn && !padPrev\[k2\]\.y && gameState === 'playing'\) toggleInventory/.test(html));

    check('trees vary in height within a species', /const tall = r \* r \* r/.test(html));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
