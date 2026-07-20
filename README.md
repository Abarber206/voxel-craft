# Voxel Craft

A voxel sandbox game that runs entirely in the browser — no install, no server, no build step.
Infinite procedural terrain, mining and building, crafting and smelting, mobs, a day/night
cycle, split-screen co-op, and online multiplayer over WebRTC.

**▶ Play: https://abarber206.github.io/voxel-craft/**

## Features

- **Procedural world** — deterministic terrain from a seed, with caves, overhangs, ore veins,
  trees and a snow line. Chunks stream in around you as you walk.
- **Voxel lighting** — Minecraft-style flood-fill skylight and torch light, baked per vertex.
  Caves are genuinely dark; torches light the room they're in, not the chunk they're in.
- **Sun shadows** — real shadow maps from a sun that travels across a 20-minute day.
- **Survival and creative** — tool tiers, durability, hunger-free health, armour, mobs that
  burn in daylight.
- **Crafting and smelting** — 3×3 grid with real recipe shapes, furnaces with fuel burn times.
- **Split-screen co-op** — two players on one machine, keyboard and/or gamepads.
- **Online multiplayer** — peer-to-peer, no server to run or pay for.

## Multiplayer

Networking is peer-to-peer over WebRTC using the public PeerJS broker, so there is nothing
to host or configure. One player hosts and shares a 5-character code.

**To host:** click **Host** (top right). A code appears — send it to your friends.

**To join:** type the code into the box and click **Join**.

The host's world seed and every block edit are synced to guests automatically. Guests talk
only to the host, which relays between them (star topology), so the host's connection carries
the traffic.

> **This only works over HTTPS.** Browsers block WebRTC on pages opened directly from disk
> (`file://`). Use the GitHub Pages link above, or any HTTPS host. Opening `index.html` by
> double-clicking it will run the game fine, but the Host/Join buttons won't connect.

## Controls

**Player 1** — `W` `A` `S` `D` move, `Space` jump, `Shift` descend (creative), mouse to look,
**left click** mine, **right click** place, `E` inventory, `1`–`9` or scroll to pick a hotbar slot.

**Player 2 (split-screen)** — arrow keys move, `I` `J` `K` `L` look, `N` jump, `Right Shift`
descend, `U` mine, `O` place, `M` inventory, `P` cycle hotbar.

Gamepads are auto-detected and assignable to either player in Settings. All keys are rebindable.

## Running locally

Because of the HTTPS requirement above, serve the folder rather than opening the file:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

`localhost` counts as a secure context, so multiplayer works there too.

## Project layout

| File | What it is |
| --- | --- |
| `index.html` | The game: worker-based chunk pipeline, light engine, renderer, UI |
| `game-systems.js` | Textures (`TexGen`), items, inventory, crafting, smelting, saves |
| `net-module.js` | `VoxelNet` — WebRTC star-topology networking over PeerJS |
| `game-architecture.md` | Design notes on how the systems fit together |

Three.js and PeerJS load from a CDN at runtime; there are no dependencies to install.

## Tests

Five suites, no test framework needed — each is a plain Node script:

```bash
node systems-test.mjs        # inventory, crafting, smelting, item DB, saves
node light-test.mjs          # light engine: skylight, torches, removal, chunk seams
node shader-test.mjs         # the baked-light GLSL injection
node perf-test.mjs           # chunk pipeline throughput, culling, memory
node integration-test.mjs    # real terrain end-to-end: generate -> light -> mesh
```

`shader-test.mjs` does a deeper check when Three.js is resolvable — either install it
(`npm install three`) or point it at a copy:

```bash
THREE_PATH=/path/to/three/build/three.cjs node shader-test.mjs
```

## License

MIT
