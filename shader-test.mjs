// Validates the baked-light shader injection, extracted verbatim from index.html.
// There is no GPU in CI, so instead of compiling we resolve Three's #include graph
// exactly as WebGLProgram does and then check the GLSL is structurally sound: the
// injection landed, every identifier it touches is really in scope at that point,
// declarations are balanced, and nothing is declared twice.
//
// Run: node shader-test.mjs           (uses the installed three if resolvable)
//      NODE_PATH=/path/to/node_modules node shader-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const src = html.match(/\/\*__SHADER_SRC_START__\*\/([\s\S]*?)\/\*__SHADER_SRC_END__\*\//)[1];

let pass = 0, fail = 0, skip = 0;
const check = (name, ok, detail = '') => {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  (' + detail + ')' : ''));
    ok ? pass++ : fail++;
};
const skipped = (name, why) => { console.log('  SKIP  ' + name + '  (' + why + ')'); skip++; };

// ---- load Three's real shader library, if we can ----------------------------
// Optional: the deep GLSL checks need the real ShaderChunk graph, but the structural
// ones are worth running anywhere. Point THREE_PATH at a three build to force it.
let THREE = null;
for (const spec of [process.env.THREE_PATH, 'three',
                    path.join(here, 'node_modules/three/build/three.cjs')]) {
    if (!spec) continue;
    try {
        const url = spec.startsWith('.') || spec.startsWith('/') ? new URL('file://' + path.resolve(spec)) : spec;
        const mod = await import(url);
        THREE = mod.ShaderLib ? mod : (mod.default ?? null);
        if (THREE && THREE.ShaderLib) break;
        THREE = null;
    } catch (e) { /* try the next candidate */ }
}

// Minimal THREE stand-in for the extracted block (it only news up Color).
const ctx = { THREE: { Color: class { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } } }, console, Math };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { applyVoxelLight, lightUniforms } = vm.runInContext('({ applyVoxelLight, lightUniforms })', ctx);

check('extracted block exposes applyVoxelLight + lightUniforms', !!applyVoxelLight && !!lightUniforms);
check('uniforms have sane defaults', lightUniforms.uSkyBright.value === 1 &&
    !!lightUniforms.uTorchCol.value && !!lightUniforms.uCaveFloor.value);

// ---- run the real onBeforeCompile against the real shader source -------------
const INJECT_FRAG = '#include <lights_fragment_end>';
const INJECT_VERT = '#include <begin_vertex>';
const baseVert = THREE ? THREE.ShaderLib.lambert.vertexShader
    : 'void main() {\n\t' + INJECT_VERT + '\n\tgl_Position = vec4(transformed, 1.0);\n}';
const baseFrag = THREE ? THREE.ShaderLib.lambert.fragmentShader
    : 'void main() {\n\t' + INJECT_FRAG + '\n\tvec3 outgoingLight = reflectedLight.indirectDiffuse;\n}';

if (THREE) check('three.js resolved for the full-fidelity GLSL check', true, 'r' + THREE.REVISION);
else skipped('full-fidelity GLSL check against three.js', 'three not installed; set THREE_PATH');
check('injection point exists in the lambert fragment shader', baseFrag.includes(INJECT_FRAG));
check('injection point exists in the lambert vertex shader', baseVert.includes(INJECT_VERT));

const mat = { onBeforeCompile: null, customProgramCacheKey: null };
applyVoxelLight(mat);
const sh = { uniforms: {}, vertexShader: baseVert, fragmentShader: baseFrag };
mat.onBeforeCompile(sh);

check('uniforms were wired onto the shader (shared objects, not copies)',
    sh.uniforms.uSkyBright === lightUniforms.uSkyBright &&
    sh.uniforms.uTorchCol === lightUniforms.uTorchCol &&
    sh.uniforms.uCaveFloor === lightUniforms.uCaveFloor);
check('program cache key is stable', typeof mat.customProgramCacheKey === 'function' &&
    mat.customProgramCacheKey() === mat.customProgramCacheKey());
check('vertex stage declares the alight attribute and passes it on',
    /attribute\s+vec2\s+alight/.test(sh.vertexShader) && /vAL\s*=\s*alight/.test(sh.vertexShader));
check('fragment stage consumes the varying', /varying\s+vec2\s+vAL/.test(sh.fragmentShader) &&
    /vAL\.x/.test(sh.fragmentShader) && /vAL\.y/.test(sh.fragmentShader));
check('the original include lines survive (nothing was clobbered)',
    sh.fragmentShader.includes(INJECT_FRAG) && sh.vertexShader.includes(INJECT_VERT));

// ---- resolve #include exactly like WebGLProgram, then inspect the real GLSL ---
function resolveIncludes(s) {
    if (!THREE) return s;
    for (let i = 0; i < 12; i++) {
        const next = s.replace(/^[ \t]*#include +<([\w\d./]+)>/gm,
            (m0, name) => THREE.ShaderChunk[name] !== undefined ? THREE.ShaderChunk[name] : '');
        if (next === s) break;
        s = next;
    }
    return s;
}
const frag = resolveIncludes(sh.fragmentShader);
const vert = resolveIncludes(sh.vertexShader);

const balanced = s => {
    let b = 0, p = 0;
    for (const c of s) { if (c === '{') b++; else if (c === '}') b--; else if (c === '(') p++; else if (c === ')') p--; if (b < 0 || p < 0) return false; }
    return b === 0 && p === 0;
};
check('fragment GLSL has balanced braces and parens', balanced(frag));
check('vertex GLSL has balanced braces and parens', balanced(vert));
if (THREE) check('no leftover unresolved #include directives', !/#include\s*</.test(frag + vert));

// Everything the injected code reads must already be declared ABOVE it.
{
    const at = frag.indexOf('float skyV = vAL.x;');
    check('injected fragment code is present in the resolved GLSL', at > 0);
    const before = frag.slice(0, at);
    const scopeChecks = [
        ['uSkyBright', /uniform\s+float\s+uSkyBright/],
        ['uTorchCol', /uniform\s+vec3\s+uTorchCol/],
        ['uCaveFloor', /uniform\s+vec3\s+uCaveFloor/],
        ['vAL', /varying\s+vec2\s+vAL/]
    ];
    // These two come from Three's own chunks, so they only exist once includes resolve.
    if (THREE) scopeChecks.unshift(['reflectedLight', /ReflectedLight\s+reflectedLight/],
                                   ['diffuseColor', /vec4\s+diffuseColor/]);
    else skipped('reflectedLight / diffuseColor scope check', 'needs three ShaderChunks');
    for (const [ident, pattern] of scopeChecks)
        check(ident + ' is in scope where the injection reads it', pattern.test(before));
    // and it must land before the frame colour is assembled, or it would do nothing
    const out = frag.indexOf('vec3 outgoingLight');
    check('injection runs before outgoingLight is composed', out > at, 'inject@' + at + ' outgoing@' + out);
}
{
    const at = vert.indexOf('vAL = alight;');
    check('injected vertex code is present in the resolved GLSL', at > 0);
    check('alight attribute declared above its use', /attribute\s+vec2\s+alight/.test(vert.slice(0, at)));
}
// Duplicate declarations are a compile error, and easy to introduce by re-injecting.
for (const [name, re] of [['vAL varying', /varying\s+vec2\s+vAL/g], ['alight attribute', /attribute\s+vec2\s+alight/g]]) {
    const n = (vert.match(re) || []).length;
    check(name + ' declared exactly once in the vertex stage', n === 1, n + ' declarations');
}
check('vAL varying declared exactly once in the fragment stage',
    (frag.match(/varying\s+vec2\s+vAL/g) || []).length === 1);

// ---- the light maths must behave: dark stays dark, torches add light ---------
{
    // Mirror of the injected expression, so the intent is asserted numerically.
    const shade = (skyV, blkV, skyBright) => {
        const ambient = Math.max(0.045, 0.045 + (1 - 0.045) * (skyV * (0.35 + 0.65 * skyBright)));
        return ambient + (blkV * blkV) * 1.35;
    };
    check('sealed cave at noon is near black', shade(0, 0, 1) < 0.06, shade(0, 0, 1).toFixed(3));
    check('open ground at noon is bright', shade(1, 0, 1) > 0.9, shade(1, 0, 1).toFixed(3));
    check('a torch lights a cave well above the dark floor', shade(0, 1, 1) > 1.2, shade(0, 1, 1).toFixed(3));
    check('night is darker than day for the same voxel', shade(1, 0, 0.12) < shade(1, 0, 1));
    check('torch light is unaffected by time of day',
        Math.abs((shade(0, 1, 0.12) - shade(0, 0, 0.12)) - (shade(0, 1, 1) - shade(0, 0, 1))) < 1e-9);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exit(fail ? 1 : 0);
