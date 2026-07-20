# Voxel Engine — Architecture & Memory Log

Split-screen co-op Minecraft clone. Three.js r160, single-file `index.html` (must run from `file://` by double-click, which forbids local module/worker file imports — hence Blob workers and inline modules).

## System Design

```
index.html
├─ WORKER (Blob, ×2 pool)          — 3D simplex noise gen + face-culled meshing, off main thread
│   ├─ SimplexNoise (seeded, permutation tables)
│   ├─ genPadded(cx,cy,cz): 18³ Uint8Array (16³ chunk + 1-voxel border resampled from noise
│   │     → exact boundary culling with zero cross-chunk messaging)
│   └─ mesh(padded): merged BufferGeometry arrays (pos/normal/color/index), 1 draw call/chunk,
│         faces emitted only where neighbor is air; transferables back to main
├─ ChunkManager                    — load radius around both players, priority queue → worker pool,
│                                    unload + geometry.dispose(), editsByChunk overlay, remesh path
├─ Physics                         — fixed 60 Hz step, gravity, per-axis AABB sweep vs voxel grid
├─ Input                           — Gamepad API (sticks, RT=break LT=place A=jump, d-pad block select)
│                                    + keyboard/mouse fallback (P1 WASD+mouse, P2 arrows+IJKL)
├─ Raycast                         — Amanatides–Woo DDA voxel traversal, 6-block reach, face normal
├─ Net (VoxelNet)                  — PeerJS signaling (session ID), WebRTC DataChannels, star topology
│                                    host-authoritative relay; syncs state @15 Hz, block edits, world seed+edit log
└─ Render loop                     — scissor split-screen (2 viewports), interpolated remote avatars, HUD
```

## Key decisions

- **Merged geometry over InstancedMesh**: face culling removes ~95%+ of faces; instancing can't skip per-face. One mesh per chunk, shared material → 1 draw call/chunk, Three's per-mesh frustum culling free via bounding spheres.
- **Terrain = f(x,y,z,seed) deterministic**: 3D density `(heightField(x,z) − y) + 9·noise3(x,y,z)` gives overhangs; separate 3D noise carves caves. Determinism ⇒ padded border regen is exact (no seams) and multiplayer only syncs *edits*, not chunks.
- **Voxel data**: Uint8Array(4096)/chunk on main thread (physics, raycast, remesh padding). Edits kept in per-chunk overlay maps that survive unload and replay onto regenerated chunks.
- **World**: 16×16×16 chunks, height 3 chunks (y 0–47), load radius 4 (circular), fog hides frontier.
- **Networking**: session ID via PeerJS cloud (user-approved); data itself is P2P DataChannels. Guests connect to host only; host relays. New peer receives `{seed, editLog}` → regenerates world locally.

## Status

- [x] Starter analyzed (split-screen scissor rendering, gamepad polling preserved)
- [x] Chunk worker (simplex + culled mesher, Blob workers ×2–4, transferable buffers)
- [x] Chunk manager + rendering (priority queue, dispose-on-unload, edit overlay, remesh revisions)
- [x] Perf verification — see results below (`node --expose-gc perf-test.mjs`, 10/10 checks)
- [x] Physics (gravity, per-axis AABB, both players) + input (RT dig / LT place / A jump / d-pad select; WASD+mouse and arrows+IJKL fallback)
- [x] WebRTC multiplayer (subagent-built `net-module.js`, 37 mocked-PeerJS assertions passing)
- [x] Integration (state @15 Hz, block edits, seed+edit-log world sync, remote avatars, session UI)
- [~] Final in-browser smoke test — headless checks all green (syntax of both scripts, worker executed for real in Node); visual check is manual: double-click `index.html` (needs internet for the three.js/PeerJS CDNs; keep `net-module.js` next to it)

## Perf results (Node harness on extracted worker source, 183-chunk load set)

- gen+mesh: avg **6.46 ms**/chunk, median 6.86, max 10.2 — single thread; the game spreads this over 2–4 workers, main thread never blocks
- hidden-face culling: **95.4%** (96,469 faces emitted vs 2,118,468 naive) — 16.2 MB of buffers vs 243 MB uncled
- memory: **90 KB/chunk** avg (voxels + pos/normal/color/index), ~2,109 verts/chunk
- draw calls: ≤ **144** for the entire load set (1 per non-empty chunk; fully-buried chunks emit zero geometry), further cut by Three's per-mesh frustum culling
- correctness: deterministic per seed; cross-chunk seam faces match neighbor voxels exactly in both directions

## Next steps

1. Browser smoke test (console clean, world renders in both viewports).
2. Hand off. See Future work for v2 candidates.

---

# v2 update

New file `game-systems.js` (engine-agnostic: TexGen, ItemDB, InventoryManager, Crafting, InventoryUI, DataSerializer, SaveManager). Changes to `index.html`: worker (trees, UVs, quantized attributes), module (menus/state machine, inventory + save integration).

## v2 features

- **Movement inversion fixed**: the yaw-space velocity mapping had forward/back sign-flipped (`mz = -cos(yaw)·moveZ` instead of `+cos(yaw)·moveZ`); strafe was fine, which matched the symptom.
- **Textures**: uploads were pasted inline (no files reach disk), so TexGen recreates all five (dirt, grass side, stone, log, leaves) as seeded procedural 16×16 tiles matched to their palettes, plus generated tiles (grass top, log top, sand, snow, plank). Runtime canvas atlas (4×4×16px), NearestFilter + no mipmaps + half-texel-inset UVs = zero blur; `image-rendering: pixelated` for UI icons. **Per-face random UV mirroring (sides, stays upright) and 0/90/180/270 rotation (tops/bottoms)** breaks tiling repetition. Normals quantized to Int8, shade to Uint8 (normalized attributes) → 79 KB/chunk incl. UVs.
- **Trees**: deterministic `f(x,z,seed)` — hash-gated trunk columns, surface found by scanning the true 3D density (so no floating trees over caves/overhangs), heights 4–6 from a second hash, MC-style canopy with hash-raggedy corners. Each chunk scans the 22×22 trunk candidates whose radius-2 canopies can reach its padded region → cross-chunk trees mesh seam-identically with zero messaging.
- **Menus + Start button**: title screen (world list / create with name+seed / delete) — START on any controller, Enter, or double-click begins split-screen; in game START/Esc pauses (Resume · Save · Save & Quit), Esc-from-pointer-lock pauses via `pointerlockchange`.
- **Inventory** (per player): 27 main + 9 hotbar + 4 armor (slot-filtered) + off-hand + 2×2 craft + output. Stacking (64/16/1) with overflow spill; left-click pick/place/combine/swap, right-click half/one, shift-click quick-transfer + auto-equip + shift-craft (capacity-checked, no dupes); cursor-follow stack, dynamic tooltips (name/type/armor/damage/count), hover highlight. Hotbars: 1-9 + wheel (P1), P (P2), d-pad (pads); E/M/gamepad-Y opens. Survival loop: breaking adds to inventory (leaves 8% apple), placing consumes, apples eat. Recipes: log→4 planks, 2 planks→4 sticks, 4 planks→helm, 4 stone→pick.
- **Save/load**: localStorage keys mirror `Saves/<World>/{metadata,player,chunks}` and load independently. Metadata (name/seed/timeOfDay/weather/playtime), full player state (pos/rot/health/activeSlot/inventory), chunk data as **diff-only** edit log. JSON (dev) or compact binary (`SAVE_BINARY`), auto-detected on load. Async save (yields between files), auto-save 2 min, manual + save-on-quit hooks. Load order: seed → diff into `editsByChunk` → place players → restore inventories. Day/night cycle (10 min) driven by persisted `timeOfDay`.

## v2 assumptions

No item-drop entities (grid/cursor items return to bag on close; voided only if 100% full). Health persisted but no damage sources; apples restore it. Inventories are per-machine in multiplayer; hosted-world saves are the local copy. Multiplayer session UI lives in-game (host/join after starting a world).

## v2 verification (all green)

- `perf-test.mjs` 13/13: syntax ×3, determinism, exact seam culling both directions, **94.9% faces culled**, 6.3 ms/chunk, **79 KB/chunk**, UV consistency, trees present.
- `systems-test.mjs` 22/22: stacking/overflow/spill, 16/1 stack caps, full-inventory leftover + exact `canFit`, armor filtering, inventory round-trip, crafting matcher (position-independence, shape rejection), JSON+binary chunk-diff round-trips, SaveManager save/load/list/delete.

---

# v3 update

## View modes: split-screen is now a toggle

Single fullscreen view (1 local player, MC-style 70° FOV) is the default; split-screen co-op is one click away (title + pause "Split-screen" button, persisted preference) — or press START on a **second** controller at the title to jump straight into split. Toggling mid-game parks/drops-in P2 next to P1 (inventory persists in saves either way). Cross-PC co-op (Host/Join) works in both modes; peers that leave split mode hide their second avatar remotely.

## Split-screen fixes + optimizations

Gamepads map by **connection order**, not raw index (a controller that reconnects as index 1 still drives P1). Target highlights are now layer-masked per viewport (you only see your own). Split renders at pixel-ratio ≤1.5 (vs ≤2 single) since it draws the world twice. `scene.updateMatrixWorld()` runs once per frame instead of once per render pass. Avatar box geometries are shared (peer join/leave no longer allocates/disposes geometry).

## First-person arm (single-view mode)

Separate depth-cleared overlay pass with its own 70° camera, lit to match the world's time of day. Bare Steve arm (skin-textured 4×12×4 box) when the slot is empty; a 45°-yawed mini block cube with correct per-face tiles when holding a block; a pixel-sprite plane for tools/food. Animations follow Minecraft's ItemInHandRenderer curves: swing `sin(√f·π)` arc out / `sin(f·π)` return with ~80° chop + inward twist (triggered by dig/place, auto-repeats while mining), equip dip on hotbar switch, walk bobbing on hand and camera (plus subtle camera roll), and look-sway lag on quick turns.

## Shading overhaul

Per-vertex **ambient occlusion** in the mesher (3-neighbor corner probes, multipliers 0.45/0.66/0.84/1.0, quad diagonal flipped toward the brighter pair to kill AO seams) — this is the big "not bland anymore" change. Face shading now uses Minecraft's real constants (top 1.0, Z 0.8, X 0.6, bottom 0.5). Flat ambient replaced with a sky/ground **hemisphere light** plus a **warm sun that travels** with timeOfDay, tinting orange through dawn/dusk (sky and fog get the same horizon glow).

## Texture polish

New layered tile pipeline (base jitter → clumps/strands/cracks/grain passes) with a harmonized warm palette: dirt got soil clumps + pebbles, grass top has strands and sunlit tips, the grass side lip is jagged with tufts and an under-shadow, stone has drifting cracks and worn patches, logs have wavy broken grain + a knot, leaves mix depth holes with lit clusters, sand ripples, planks have per-board tint/grain/staggered joints. Plus a skin-tone arm texture.

## v3 verification (all green)

`perf-test.mjs` 14/14 — culling still 94.9%, 6.1 ms/chunk, 79 KB/chunk (AO added zero bytes: it rides in the existing Uint8 colors), new AO-variation check; `systems-test.mjs` 22/22 unchanged.

---

# v4 update

## Bug fixes (from user screenshots)

- **Single-view divider + double HUD**: `setState` assigned `body.className`, wiping the `mode-single` class every state change — the split divider, second crosshair, and second hotbar leaked back into fullscreen mode. Now classList add/remove.
- **Controller hijacking Player 1**: pads are no longer hard-mapped by index. Settings > Controllers assigns each connected pad to **P1 / P2 / Off**, so one controller can drive P2 while the keyboard drives P1. START from a P2-assigned pad still launches split-screen from the title.

## Settings menu (title + pause, Esc/START backs out)

Top-of-screen controls text removed. Video: render distance 2-6 chunks (live — fog and streaming radius follow), FOV 60-90, view bobbing. Mouse sensitivity. Controllers: per-pad player assignment + gamepad reference. **Custom keybinds: every P1/P2 action is rebindable to any key or mouse button** (click a binding, press the input; Esc cancels; persisted with all other prefs in `voxel/prefs`).

## Content overhaul

- **13 new blocks** (ids 9-21): cobblestone, stone bricks, sandstone, gravel, coal/iron/gold/diamond ore, crafting table, bookshelf, mossy cobblestone, obsidian, furnace. Atlas grew to 8x8 (27 tiles).
- **Ore generation**: banded 3D-noise veins in stone, type picked by depth via per-voxel hash (coal < y42, iron < y30, gold < y18, diamond < y10) + gravel pockets. Deterministic, so padded borders and multiplayer stay exact.
- **MC drops**: stone→cobblestone, grass→dirt, ores→coal/ingots/diamond (adapted: no smelting yet), leaves→5% apple / 70% leaves.
- **Crafting table block**: right-click it (any hand) to open a **3x3 crafting UI**; the personal screen keeps the 2x2 window. One 3x3 grid model underneath — the 2x2 simply can't fit 3-wide recipes, exactly like MC.
- **45 recipes**, real MC shapes: planks/sticks/table/furnace, sandstone, stone bricks (adapted from cobble), bookshelf (adapted), mossy (shapeless), **5 tool kinds x 5 material tiers** (pickaxe MMM/_S_/_S_, axe, shovel, sword, hoe) and **3 armor sets** (helmet/chestplate/leggings/boots for iron/gold/diamond with MC protection points). 64 items total.
- **Tool-speed mining**: block families (stone/wood/dirt/leaves) have base break delays; the matching tool class + higher tier mines much faster; obsidian effectively needs a diamond pickaxe.
- Arm/held block enlarged and moved closer to center (scale 1.15, bigger held cube) per feedback.

## v4 verification (all green)

`perf-test.mjs` 15/15 (ore-vein check added; gen 8.5 ms/chunk with ores — still under budget, culling 94.9%, 79 KB/chunk). `systems-test.mjs` 32/32: generated ItemDB (tiers/armor points), 3x3 matcher against real shapes incl. offsets, shapeless, junk rejection, old-save item migration, plus the previous inventory/serializer/save suites.

---

# v5 update — Survival vs Creative

Game mode is **per-world** (`mode` in metadata; title picks it for new worlds, pause menu switches live like /gamemode, host's mode syncs to co-op guests).

**Survival**: tool-aware break times (unchanged), **tool durability** — real MC values (wood 59 / stone 131 / iron 250 / gold 32 / diamond 1561), one point per block, tool shatters at zero; durability bars on slots + hotbar, shown in tooltips, persisted per-stack in saves (legacy saves backfill to full). **Health**: hearts HUD per player (10 hearts, half-heart steps), fall damage from the airborne peak (floor(fall − 3)), void deaths, slow regen (1 HP / 4 s), apples heal +4; death respawns at world spawn with inventory kept (no drop entities). **Creative**: instant breaking, no drops, no tool wear, free placing/eating, no hearts, **item catalog** in the inventory (every item; left = stack, right = one, shift = to bag, click with held stack = destroy), and **flight** — double-tap jump toggles, jump/descend to fly (descend bindable, default Shift; gamepad B), landing ends flight.

**Split-screen inventory fix**: the inventory/crafting panel now docks over the *opening player's half* only (`#invWrap.half-left/.half-right`), so P2's screen stays playable while P1 browses and vice versa; fullscreen mode still centers it.

Verification: 15/15 engine + **38/38 systems** (new: MC durability values, mk()/addItem full-durability, worn-durability save round-trip, legacy backfill, catalog completeness).

---

# v6 update — the big survival spec

**Timed mining**: hold-to-break with real progress — ~1s with the correct tool (tiers shave it to ~0.5s), punching stone 3.6s, wood/axe, dirt/shovel, obsidian needs diamond; 4-stage procedural **crack overlay** on the mined block with a growing **shake**; releasing early resets, drops only on completion; creative stays instant/animation-free.

**Torches (recipe verified by test: coal OR charcoal above stick, any column/offset → 4)**, rendered as small self-lit posts (custom mesher geometry, walk-through, non-occluding). **Glass** via cutout alpha (smelt sand). **Redstone ore** added.

**Ore rebalance**: per-chunk vein-center precompute (fast) with Manhattan falloff → natural 1-5 block clusters at MC depth ranges (coal 3-5 y5-52, iron 2-4 y5-54, gold 1-3 y5-29, diamond 1-2 y1-15, redstone 2-4 y1-15); measured **0.54% of stone** (was 1.6%); different types virtually never touch (sparse centers). Deterministic + seam-exact as always.

**Terrain**: world height 112; ridged-noise **mountains** up to ~104 with a proper **snow line** (none <80, patchy 80-95, full 95+); **guaranteed soil strata** — grass → 1-3 dirt (1 on high slopes) → stone, verified 0 stone-under-grass violations across 13.7k grass blocks; deserts: sand → sandstone → stone; reduced 3D overhang amplitude (fewer floaters — full support-check remains future work).

**Furnace**: right-click to open — input/fuel/output slots, animated 10s progress bar, fuel-remaining bar, 1 coal = 8 smelts, out-of-fuel decay; recipes iron/gold ore→ingots (ore blocks now drop THEMSELVES — un-adapts the chain), sand→glass, cobble→stone, log→charcoal; shift-click routes fuels/smeltables to the right slot; per-block state persisted in a 4th save file (`/furnaces`), contents refund on break.

**Arm v2**: slimmer two-segment arm (upper + forearm, idle **elbow bend**), shortened so it never leaves the frame, tools gripped at the fist, MC arc swing retained; third-person avatars got both arms.

**Hunger**: 10-drumstick bar beside hearts, hidden **saturation** depletes first; drains 1/min idle, 1 per 10 jumps, 1 per 20 blocks mined; **hold-to-eat 1.5s** with arm-to-mouth nibble animation (release cancels); regen gated on 8+ drumsticks, starvation to half a heart; persisted per player.

**Polish**: 20-minute day/night (15/5 via asymmetric sun curve), autosave every 30s, death respawns at spawn.

**Deferred at v6** (each is engine-sized): mobs, flowing water/lava, furnace smoke particles, audio, saplings, mirrored recipes, furnace state net-sync. *(Mobs landed in v7.)* File structure stays 3 files beside index.html (double-click to play; CDNs: three.js + PeerJS only) — folding into one file would only hurt maintainability.

Verification: **17/17 engine** (incl. new ore-sparsity + soil-strata checks; 9.3 ms/chunk avg over the 427-chunk 112-tall load set, 95.9% culled, 46 KB/chunk) + **42/42 systems** (torch recipe both fuels/any offset, smelting table, burn math, durability suite, 47 recipes).

---

# v7 update — mobs, arm slimming, HUD, tool-gated drops

**Mobs** (survival only, transient — never saved, they repopulate naturally):
- **Pigs**: 10 HP, wander on grass by day, flee when struck, drop 1-2 **raw porkchops** → smelt to **cooked porkchop** (heals 8 vs 2). Box model with hip-pivoted legs that animate with speed.
- **Zombies**: 20 HP, spawn only at night (cap 12), chase within 16 blocks, melee for 3 with knockback both ways, **burn in daylight** (skylight column check), drop rotten flesh.
- Shared AABB sweep with the player, gravity, **auto-jump** on 1-block steps, hurt flash, despawn past the load radius, spawn ring 18-44 blocks out on valid ground. Attacks: a fresh dig press hits a mob in reach first (sword damage applies) before falling through to mining.

**Arm**: rebuilt to true 4px proportions (0.13 world units vs 0.25) at 0.92 scale — visibly skinny, shorter, still elbow-bent with the tool gripped at the fist.

**HUD**: hearts and drumsticks now share one glyph size and fixed-width cells, mirrored equal distances off center. The "took N fall damage" toast is gone — damage now shows as a **red screen vignette** that scales with the hit.

**Tool-gated drops** (`NEEDS_TOOL`): stone/cobble/bricks/sandstone/furnace/glass need a pickaxe; coal any pickaxe; iron stone+; gold/diamond/redstone iron+; obsidian diamond. Wrong or bare hands still breaks the block, but it drops **nothing** — wood, dirt, sand and leaves are unaffected.

**Gamepad cross-talk fix**: pad inputs now **merge** instead of overwrite — an idle second pad can no longer zero the first player's stick (the actual cause of "the controller moves the other player").

Verification: **17/17 engine** + **43/43 systems** (added porkchop smelting/heal check).
