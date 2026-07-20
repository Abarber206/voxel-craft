/**
 * game-systems.js v2 — engine-agnostic gameplay systems for the voxel engine.
 *
 * Components: TexGen (27 procedural tiles + generated tool/armor/material icons),
 * ItemDB (blocks, materials, 5 tool tiers x 5 kinds, 3 armor sets), InventoryManager,
 * Crafting (3x3 shaped + shapeless, ~46 real Minecraft recipes), InventoryUI
 * (player 2x2 / crafting-table 3x3 modes, drag-and-drop, tooltips, hotbars),
 * DataSerializer, SaveManager.
 *
 * ASSUMPTIONS: vanilla browser JS + DOM; localStorage persistence with in-memory
 * fallback; no smelting yet, so a few recipes are adapted (marked "adapted"):
 * iron/gold ore drop ingots directly, stone bricks come from cobblestone,
 * bookshelves use sticks instead of books. No item-drop entities: closing an
 * inventory returns grid/cursor stacks to the bag (voided only if 100% full).
 */

/* ========================= CUSTOM ART OVERRIDES ===========================
 * Drop your own 16x16 pixel art here and it replaces the procedural version
 * everywhere (inventory icon, hotbar, and the item held in your hand).
 *
 * Values must be data URIs, because browsers block file:// images from being
 * read into WebGL textures. To convert a PNG: open it at base64.guru or run
 *   certutil -encode file.png tmp.txt      (Windows)
 * and paste the result as "data:image/png;base64,<the-base64>".
 *
 * Keys are item ids: pickaxe_wood, pickaxe_stone, pickaxe_iron, pickaxe_gold,
 * pickaxe_diamond, and the same for axe_/shovel_/sword_/hoe_, plus blocks like
 * torch, glass, coal, diamond, apple... e.g.
 *   ART.pickaxe_iron = 'data:image/png;base64,iVBORw0KG...';
 */
const ART = {};

/* ============================== TexGen ==================================== */
const TexGen = (() => {
    const SIZE = 16, GRID = 8;               // atlas = 8x8 tiles of 16px = 128px
    function rng(seed) {
        let a = seed | 0;
        return () => {
            a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    const px = (ctx, x0, y0, x, y, r, g, b) => {
        ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
        ctx.fillRect(x0 + x, y0 + y, 1, 1);
    };
    // ---- tile pipeline: 16x16 color array -> detail passes -> blit ----
    function blit(ctx, x0, y0, m) {
        for (let i = 0; i < 256; i++) px(ctx, x0, y0, i & 15, i >> 4, m[i][0], m[i][1], m[i][2]);
    }
    function base(seed, col, vary, fn) {
        const r = rng(seed), m = [];
        for (let i = 0; i < 256; i++) {
            const v = (r() * 2 - 1) * vary;
            m.push([col[0] + v, col[1] + v * 0.92, col[2] + v * 0.85]);
        }
        if (fn) fn(m, rng(seed + 7));
        return m;
    }
    const dk = (m, i, d) => { m[i] = [m[i][0] - d, m[i][1] - d, m[i][2] - d]; };
    const lt = (m, i, d) => dk(m, i, -d);
    const blob = (m, r, n, d, w) => {
        for (let k = 0; k < n; k++) {
            const X = (r() * 16) | 0, Y = (r() * 16) | 0;
            for (let oy = 0; oy < w; oy++) for (let ox = 0; ox < w; ox++)
                dk(m, ((Y + oy) & 15) * 16 + ((X + ox) & 15), d);
        }
    };
    const cobbleBase = (seedA) => { // shared by cobble / mossy
        const m = base(seedA, [118, 118, 121], 7);
        for (let Y = 0; Y < 16; Y++) for (let X = 0; X < 16; X++) {
            const wob = ((X * 5 + Y * 3) % 4) - 1;
            if ((X + wob) % 8 === 0 || (Y + ((X >> 2) % 3)) % 8 === 0) dk(m, Y * 16 + X, 22);
        }
        return m;
    };
    const oreDraw = (seedN, col, colD) => (c, x, y) => { // stone + colored nuggets
        const m = base(seedN, [127, 127, 130], 6);
        const r = rng(seedN + 1);
        for (let k = 0; k < 5; k++) {
            const X = 1 + (r() * 12) | 0, Y = 1 + (r() * 12) | 0;
            m[Y * 16 + X] = col; m[Y * 16 + X + 1] = col; m[(Y + 1) * 16 + X] = col;
            m[(Y + 1) * 16 + X + 1] = colD;
            if (r() < 0.5) m[Y * 16 + ((X + 2) & 15)] = colD;
        }
        blit(c, x, y, m);
    };
    // Small flower on a stem, bottom-anchored to match the grass tuft.
    const flowerDraw = (petal, hilite) => (c, x, y) => {
        const s = (X, Y, col) => { c.fillStyle = 'rgb(' + col + ')'; c.fillRect(x + X, y + Y, 1, 1); };
        for (let Y = 9; Y < 16; Y++) s(7, Y, Y > 12 ? '70,120,44' : '86,140,54');   // stem
        s(6, 12, '86,140,54'); s(9, 11, '86,140,54');                               // leaves
        s(8, 12, '70,120,44'); s(5, 11, '70,120,44');
        for (const [X, Y] of [[6, 6], [7, 5], [8, 6], [7, 7], [6, 8], [8, 8]]) s(X, Y, petal);
        s(7, 6, hilite); s(7, 8, petal);
        s(6, 7, '250,222,120'); s(8, 7, '236,200,96');                              // pollen centre
    };
    const TILES = {
        // -- recreations of the uploaded textures (upgraded detail, same character) --
        dirt: (c, x, y) => blit(c, x, y, base(11, [104, 76, 50], 9, (m, r) => {
            blob(m, r, 9, 14, 2);
            for (let k = 0; k < 6; k++) lt(m, (r() * 256) | 0, 22);
        })),
        grass_side: (c, x, y) => {
            const r = rng(33);
            const m = base(34, [104, 76, 50], 9, (m2, r2) => blob(m2, r2, 7, 12, 2));
            for (let X = 0; X < 16; X++) {
                const depth = 2 + (r() < 0.55 ? 1 : 0) + (r() < 0.16 ? 2 : 0);
                for (let Y = 0; Y <= depth; Y++) {
                    const v = (r() * 2 - 1) * 10;
                    m[Y * 16 + X] = [100 + v, 148 + v, 60 + v * 0.6];
                }
                dk(m, ((depth + 1) & 15) * 16 + X, 14);
            }
            blit(c, x, y, m);
        },
        stone: (c, x, y) => blit(c, x, y, base(44, [127, 127, 130], 6, (m, r) => {
            for (let k = 0; k < 7; k++) {
                let X = (r() * 16) | 0, Y = (r() * 16) | 0;
                const L = 3 + (r() * 3 | 0);
                for (let s = 0; s < L; s++) {
                    dk(m, (Y & 15) * 16 + (X & 15), 24);
                    X += 1; Y += (r() * 3 | 0) - 1;
                }
            }
            blob(m, r, 4, -12, 2);
        })),
        log_side: (c, x, y) => {
            const r = rng(55), colT = [], groove = [];
            for (let i = 0; i < 16; i++) { colT.push((r() * 2 - 1) * 10); groove.push(r() < 0.25); }
            const m = base(56, [108, 84, 52], 4);
            for (let Y = 0; Y < 16; Y++) for (let X = 0; X < 16; X++) {
                const wave = Math.sin(Y * 0.7 + X * 1.9) * 4;
                let t = colT[X] + wave;
                if (groove[X] && r() > 0.12) t -= 26;
                const i = Y * 16 + X;
                m[i] = [m[i][0] + t, m[i][1] + t * 0.9, m[i][2] + t * 0.7];
            }
            dk(m, 6 * 16 + 11, 30); dk(m, 7 * 16 + 11, 30); dk(m, 7 * 16 + 12, 30);
            blit(c, x, y, m);
        },
        leaves: (c, x, y) => blit(c, x, y, base(77, [70, 112, 48], 13, (m, r) => {
            for (let k = 0; k < 22; k++) dk(m, (r() * 256) | 0, 34);
            for (let k = 0; k < 14; k++) lt(m, (r() * 256) | 0, 18);
            blob(m, r, 5, 18, 2);
        })),
        // -- generated tiles (palette-matched) --
        grass_top: (c, x, y) => blit(c, x, y, base(22, [106, 152, 64], 11, (m, r) => {
            blob(m, r, 10, 16, 1);
            for (let k = 0; k < 12; k++) {
                const X = (r() * 16) | 0, Y = (r() * 15) | 0;
                dk(m, Y * 16 + X, 20); dk(m, ((Y + 1) & 15) * 16 + X, 12);
            }
            for (let k = 0; k < 8; k++) lt(m, (r() * 256) | 0, 14);
        })),
        log_top: (c, x, y) => {
            const m = base(66, [150, 118, 68], 5);
            for (let Y = 0; Y < 16; Y++) for (let X = 0; X < 16; X++) {
                const d = Math.max(Math.abs(X - 7.5), Math.abs(Y - 7.5));
                const i = Y * 16 + X;
                if (d >= 6.5) { const v = m[i][0] - 150; m[i] = [92 + v, 70 + v, 44 + v]; }
                else if ((d | 0) % 2) dk(m, i, 26);
                if (d < 1) dk(m, i, 34);
            }
            blit(c, x, y, m);
        },
        sand: (c, x, y) => blit(c, x, y, base(88, [221, 205, 155], 6, (m, r) => {
            for (let Y = 2; Y < 16; Y += 5)
                for (let X = 0; X < 16; X++) if (r() < 0.7) dk(m, Y * 16 + X, 7);
            for (let k = 0; k < 8; k++) dk(m, (r() * 256) | 0, 16);
        })),
        snow: (c, x, y) => blit(c, x, y, base(99, [242, 246, 251], 3, (m, r) => {
            for (let k = 0; k < 6; k++) lt(m, (r() * 256) | 0, 5);
            for (let k = 0; k < 4; k++) dk(m, (r() * 256) | 0, 8);
        })),
        plank: (c, x, y) => {
            const r = rng(101);
            const boardT = [0, 0, 0, 0].map(() => (r() * 2 - 1) * 7);
            const m = base(102, [166, 130, 78], 5);
            for (let Y = 0; Y < 16; Y++) for (let X = 0; X < 16; X++) {
                const i = Y * 16 + X, board = Y >> 2, t0 = boardT[board];
                if (Y % 4 === 3) { m[i] = [96 + t0, 73 + t0 * 0.9, 44 + t0 * 0.75]; continue; }
                let t = t0 + Math.sin(X * 1.1 + board * 2) * 3;
                if (board % 2 ? X === 3 : X === 11) t -= 22;
                if (r() < 0.06) t -= 12;
                m[i] = [m[i][0] + t, m[i][1] + t * 0.9, m[i][2] + t * 0.75];
            }
            blit(c, x, y, m);
        },
        white: (c, x, y) => blit(c, x, y, base(1, [250, 250, 250], 0)),
        arm: (c, x, y) => {
            const m = base(111, [199, 148, 112], 6, (m2, r) => {
                for (let k = 0; k < 5; k++) dk(m2, (r() * 256) | 0, 12);
            });
            for (let Y = 0; Y < 16; Y++) { dk(m, Y * 16, 14); dk(m, Y * 16 + 15, 14); }
            blit(c, x, y, m);
        },
        // -- v2 blocks --
        cobble: (c, x, y) => {
            const m = cobbleBase(121);
            blob(m, rng(122), 4, -10, 2);
            blit(c, x, y, m);
        },
        stonebrick: (c, x, y) => {
            const m = base(131, [122, 122, 125], 5);
            for (let Y = 0; Y < 16; Y++) for (let X = 0; X < 16; X++) {
                const off = ((Y >> 2) % 2) * 4, i = Y * 16 + X;
                if (Y % 4 === 3) { dk(m, i, 26); continue; }
                if ((X + off) % 8 === 7) { dk(m, i, 26); continue; }
                if (Y % 4 === 0) lt(m, i, 6);
            }
            blit(c, x, y, m);
        },
        sandstone_top: (c, x, y) => blit(c, x, y, base(141, [224, 209, 160], 4, (m, r) => {
            for (let k = 0; k < 8; k++) dk(m, (r() * 256) | 0, 10);
        })),
        sandstone_side: (c, x, y) => blit(c, x, y, base(142, [221, 205, 155], 5, (m, r) => {
            for (const Y of [4, 9, 13]) for (let X = 0; X < 16; X++) if (r() < 0.75) dk(m, Y * 16 + X, 12);
            for (let k = 0; k < 6; k++) dk(m, (r() * 256) | 0, 14);
        })),
        gravel: (c, x, y) => {
            const r = rng(151), pal = [[136, 126, 118], [108, 98, 90], [152, 144, 136], [88, 82, 76]];
            const m = [];
            for (let i = 0; i < 256; i++) {
                const p = pal[(r() * 4) | 0], v = (r() * 2 - 1) * 5;
                m.push([p[0] + v, p[1] + v, p[2] + v]);
            }
            blit(c, x, y, m);
        },
        coal_ore: oreDraw(161, [52, 52, 55], [30, 30, 33]),
        iron_ore: oreDraw(171, [226, 192, 160], [190, 150, 120]),
        gold_ore: oreDraw(181, [250, 214, 80], [210, 170, 50]),
        diamond_ore: oreDraw(191, [110, 235, 225], [70, 190, 185]),
        crafting_top: (c, x, y) => {
            const m = base(201, [166, 130, 78], 5);
            for (let i = 0; i < 16; i++) { dk(m, i, 18); dk(m, 240 + i, 18); dk(m, i * 16, 18); dk(m, i * 16 + 15, 18); }
            for (let i = 2; i < 14; i++) { dk(m, 5 * 16 + i, 14); dk(m, 10 * 16 + i, 14); dk(m, i * 16 + 5, 14); dk(m, i * 16 + 10, 14); }
            blit(c, x, y, m);
        },
        crafting_side: (c, x, y) => {
            const m = base(202, [158, 124, 74], 6);
            for (let Y = 3; Y < 13; Y++) for (let X = 2; X < 14; X++)
                if (Y === 3 || Y === 12 || X === 2 || X === 13) dk(m, Y * 16 + X, 16);
            for (const [X, Y] of [[5, 6], [6, 7], [7, 8], [9, 6], [10, 6], [9, 7]]) dk(m, Y * 16 + X, 30);
            blit(c, x, y, m);
        },
        bookshelf: (c, x, y) => {
            const m = base(211, [166, 130, 78], 5);
            const r = rng(212);
            const pal = [[168, 60, 50], [70, 110, 160], [90, 140, 70], [150, 120, 60], [120, 80, 140], [180, 150, 90]];
            for (const rowBase of [3, 9]) {
                let X = 1;
                while (X < 15) {
                    const bcol = pal[(r() * pal.length) | 0];
                    for (let Y = rowBase; Y < rowBase + 5; Y++) for (let ox = 0; ox < 2 && X + ox < 15; ox++) {
                        const i = Y * 16 + X + ox, v = (r() * 2 - 1) * 8;
                        m[i] = [bcol[0] + v, bcol[1] + v, bcol[2] + v];
                    }
                    X += 2 + (r() < 0.3 ? 1 : 0);
                }
                if (rowBase + 5 < 16) for (let X2 = 0; X2 < 16; X2++) dk(m, (rowBase + 5) * 16 + X2, 20);
            }
            blit(c, x, y, m);
        },
        mossy: (c, x, y) => {
            const m = cobbleBase(221);
            const r = rng(222);
            for (let k = 0; k < 12; k++) {
                const X = (r() * 15) | 0, Y = (r() * 15) | 0;
                for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (r() < 0.8) {
                    const i = ((Y + oy) & 15) * 16 + ((X + ox) & 15), v = (r() * 2 - 1) * 10;
                    m[i] = [64 + v, 104 + v, 46 + v * 0.6];
                }
            }
            blit(c, x, y, m);
        },
        obsidian: (c, x, y) => blit(c, x, y, base(231, [26, 20, 36], 5, (m, r) => {
            for (let k = 0; k < 7; k++) {
                const i = (r() * 256) | 0;
                m[i] = [68 + r() * 20, 46 + r() * 14, 102 + r() * 24];
            }
        })),
        furnace_front: (c, x, y) => {
            const m = base(241, [106, 106, 109], 6);
            for (let Y = 0; Y < 16; Y++) for (let X = 0; X < 16; X++)
                if (Y % 8 === 0 || X % 8 === 0) dk(m, Y * 16 + X, 16);
            for (let Y = 9; Y < 14; Y++) for (let X = 4; X < 12; X++) m[Y * 16 + X] = [26, 26, 28];
            for (let X = 4; X < 12; X++) lt(m, 8 * 16 + X, 10);
            blit(c, x, y, m);
        },
        furnace_top: (c, x, y) => blit(c, x, y, base(242, [112, 112, 115], 6, (m, r) => {
            for (let k = 0; k < 6; k++) dk(m, (r() * 256) | 0, 16);
        })),
        glass: (c, x, y) => { // cutout: transparent panes, frame + sparkles only
            const s = (X, Y, col, a) => { c.fillStyle = 'rgba(' + col + ',' + (a === undefined ? 1 : a) + ')'; c.fillRect(x + X, y + Y, 1, 1); };
            for (let i = 0; i < 16; i++) {
                s(i, 0, '214,232,242'); s(i, 15, '168,194,210');
                s(0, i, '214,232,242'); s(15, i, '168,194,210');
            }
            for (const [X, Y] of [[3, 3], [4, 2], [5, 1], [10, 9], [11, 8], [12, 7], [6, 12], [7, 11]])
                s(X, Y, '238,247,252', 0.85);
        },
        // Animated: `frame` 0-3 cycles the flame while the stick and ember cap stay put.
        // Transparent bg. Column layout matches the in-world sprite, which samples ONLY
        // texels x=7..8 for the post and rows 9-10 for the top cap — so the stick and
        // flame core must live in those two columns; x=6/x=9 carry the outer glow that
        // only the inventory icon sees.
        torch: (c, x, y, frame) => {
            // Row budget matches Minecraft's 10/16-tall torch model exactly:
            //   10-15 stick | 9 charred | 8 ember | 4-7 flame
            // The in-world post samples rows 6-15 (10 rows over 0.625 blocks, so texels
            // stay square) and the top cap samples rows 8-9, the ember.
            const s = (X, Y, col) => { c.fillStyle = 'rgb(' + col + ')'; c.fillRect(x + X, y + Y, 1, 1); };
            for (let Y = 10; Y < 16; Y++) {           // wooden stick, lit from the left
                s(7, Y, Y % 3 === 1 ? '150,118,74' : '134,104,64');
                s(8, Y, Y % 3 === 2 ? '86,63,35' : '100,75,44');
            }
            s(7, 9, '74,55,35'); s(8, 9, '58,42,26');    // charred head
            s(7, 8, '186,116,52'); s(8, 8, '156,94,40');  // ember, and the top-face cap
            // Flame: four hand-drawn shapes, each a little taller or leaner than the
            // last, so the loop reads as a flicker rather than a pulse.
            const F = [
                [[6, 7, '236,146,48'], [7, 7, '255,214,120'], [8, 7, '255,190,92'], [9, 7, '224,128,40'],
                 [6, 6, '250,190,80'], [7, 6, '255,246,198'], [8, 6, '255,228,150'], [9, 6, '246,172,66'],
                 [7, 5, '255,252,224'], [8, 5, '255,238,178'], [7, 4, '255,226,140']],
                [[6, 7, '228,138,44'], [7, 7, '255,222,136'], [8, 7, '255,198,104'], [9, 7, '218,122,38'],
                 [7, 6, '255,248,210'], [8, 6, '255,232,162'], [9, 6, '240,166,62'],
                 [7, 5, '255,244,190'], [8, 5, '255,226,148'], [7, 4, '255,232,158'], [7, 3, '255,214,120']],
                [[6, 7, '242,156,52'], [7, 7, '255,218,128'], [8, 7, '255,194,98'],
                 [6, 6, '252,196,88'], [7, 6, '255,250,214'], [8, 6, '255,230,156'], [9, 6, '236,158,56'],
                 [6, 5, '255,236,170'], [7, 5, '255,248,206'], [8, 5, '255,224,140'], [7, 4, '255,220,132']],
                [[6, 7, '232,142,46'], [7, 7, '255,216,124'], [8, 7, '255,192,96'], [9, 7, '228,134,44'],
                 [7, 6, '255,244,192'], [8, 6, '255,226,146'], [7, 5, '255,238,174'], [8, 5, '255,216,124']]
            ][(frame | 0) & 3];
            for (const [X, Y, col] of F) s(X, Y, col);
        },
        redstone_ore: oreDraw(251, [224, 58, 44], [150, 28, 22]),
        // ---- cross-sprite plants: transparent bg, bottom-anchored so they sit ON the
        // ground rather than floating. Drawn narrow so the two crossed quads read as a
        // tuft rather than a solid billboard.
        tallgrass: (c, x, y) => {
            const s = (X, Y, col) => { c.fillStyle = 'rgb(' + col + ')'; c.fillRect(x + X, y + Y, 1, 1); };
            const G1 = '92,150,58', G2 = '74,128,46', G3 = '112,172,70';
            // [rootX, height, lean, shade]
            const blades = [[3, 7, -1, G2], [5, 10, 0, G1], [7, 12, 1, G3],
                            [9, 9, 0, G1], [11, 11, -1, G2], [13, 6, 1, G2]];
            for (const [bx, hgt, lean, col] of blades) {
                for (let i = 0; i < hgt; i++) {
                    const Y = 15 - i;
                    const X = bx + Math.round(lean * (i / hgt) * 2);
                    if (X < 0 || X > 15) continue;
                    s(X, Y, i > hgt - 3 ? G3 : col);          // tips catch the light
                }
            }
        },
        flower_red: flowerDraw('196,54,54', '236,110,110'),
        flower_yellow: flowerDraw('232,196,58', '252,232,140')
    };
    // Atlas layout — the mesher bakes these indices into UVs, so ORDER MATTERS.
    const ORDER = ['grass_top', 'grass_side', 'dirt', 'stone', 'log_side', 'log_top', 'leaves',
                   'sand', 'snow', 'plank', 'white', 'cobble', 'stonebrick', 'sandstone_top',
                   'sandstone_side', 'gravel', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore',
                   'crafting_top', 'crafting_side', 'bookshelf', 'mossy', 'obsidian',
                   'furnace_front', 'furnace_top', 'glass', 'torch', 'redstone_ore',
                   'tallgrass', 'flower_red', 'flower_yellow'];  // append only: the mesher bakes these indices
    function buildAtlas(canvas) {
        canvas.width = canvas.height = SIZE * GRID;
        const ctx = canvas.getContext('2d');
        ORDER.forEach((name, i) => TILES[name](ctx, (i % GRID) * SIZE, (i / GRID | 0) * SIZE));
        return canvas;
    }
    // ---- item icons: hand-drawn bases + generated tool/armor families ----
    const MAT_COLORS = { wood: [156, 122, 70], stone: [130, 130, 132], iron: [224, 224, 226],
                         gold: [250, 212, 80], diamond: [108, 232, 220] };
    const shadeC = (col, f) => [Math.min(255, col[0] * f), Math.min(255, col[1] * f), Math.min(255, col[2] * f)];
    // Minecraft item art is a fixed 16x16 pixel grid, not a set of procedural fills,
    // so the tools are authored as literal pixel maps: the head sits at the top-left
    // with the stick running down to the bottom-right, and the sword points up-right.
    // These same maps drive the inventory slot, the hotbar and the item in the fist.
    //   '.' transparent   S/s stick lit/shaded   L/M/m material light/mid/dark
    const TOOL_ART = {
        pickaxe: ['................',
                  '................',
                  '..LMMm....mMML..',
                  '.LMMMMMMMMMMMMm.',
                  '.LMm.mMMMm.mMMm.',
                  '.mm...mSSm...mm.',
                  '.......Ss.......',
                  '........Ss......',
                  '.........Ss.....',
                  '..........Ss....',
                  '...........Ss...',
                  '............Ss..',
                  '.............Ss.',
                  '..............s.',
                  '................',
                  '................'],
        axe:     ['................',   // wedge head: curved cutting edge left,
                  '................',   // narrowing to the socket on the right
                  '..mMMMm.........',
                  '.mMLLLMMm.......',
                  'mMLLMMMMMm......',
                  'mMLMMMMMMSs.....',
                  'mMLMMMMMm.Ss....',
                  'mMMMMMMm...Ss...',
                  '.mMMMMm.....Ss..',
                  '..mMMm.......Ss.',
                  '...mm.........s.',
                  '................',
                  '................',
                  '................',
                  '................',
                  '................'],
        shovel:  ['................',   // straight-sided scoop, not a ball
                  '.mMMMm..........',
                  '.MLLMm..........',
                  '.MLMMm..........',
                  '.MLMMm..........',
                  '.mMMMm..........',
                  '.mMMmSs.........',
                  '......Ss........',
                  '.......Ss.......',
                  '........Ss......',
                  '.........Ss.....',
                  '..........Ss....',
                  '...........Ss...',
                  '............Ss..',
                  '.............s..',
                  '................'],
        hoe:     ['................',
                  '................',
                  '..mMMMMm........',
                  '.mMLLLLMm.......',
                  '.MLLMMMMMSs.....',
                  '.MLm...mm.Ss....',
                  '.mMm.......Ss...',
                  '..mm........Ss..',
                  '.............Ss.',
                  '..............s.',
                  '................',
                  '................',
                  '................',
                  '................',
                  '................',
                  '................'],
        sword:   ['..............L.',
                  '.............LM.',
                  '............LMm.',
                  '...........LMm..',
                  '..........LMm...',
                  '.........LMm....',
                  '........LMm.....',
                  '.......LMm......',
                  '......LMm.......',
                  '..m..LMm........',
                  '.mMmLMm.........',
                  'sSmMMm..........',
                  '.sSMm...........',
                  '..sSs...........',
                  '...ss...........',
                  '................']
    };
    function paintArt(ctx, rows, pal) {
        for (let y = 0; y < 16; y++) {
            const row = rows[y];
            if (!row) continue;
            for (let x = 0; x < 16; x++) {
                const c = pal[row[x]];
                if (c) px(ctx, 0, 0, x, y, c[0], c[1], c[2]);
            }
        }
    }
    // `col` comes from MAT_COLORS so every tier is visibly a different metal.
    function toolPainter(kind, col) {
        const pal = { L: shadeC(col, 1.30), M: col, m: shadeC(col, 0.64),
                      S: [140, 106, 62], s: [98, 71, 40] };
        const rows = TOOL_ART[kind];
        return ctx => paintArt(ctx, rows, pal);
    }
    function armorPainter(piece, col) {
        const dark = shadeC(col, 0.72);
        return ctx => {
            const P = (x, y, c) => px(ctx, 0, 0, x, y, c[0], c[1], c[2]);
            if (piece === 'helmet') {
                for (let x = 4; x < 12; x++) P(x, 4, col);
                for (let y = 5; y < 9; y++) {
                    P(3, y, col); P(4, y, col); P(11, y, col); P(12, y, col);
                    if (y < 7) for (let x = 5; x < 11; x++) P(x, y, col);
                }
                for (let x = 5; x < 11; x++) P(x, 3, dark);
            } else if (piece === 'chestplate') {
                for (let y = 3; y < 12; y++) for (let x = 4; x < 12; x++) {
                    if (y < 6 && x > 6 && x < 9) continue;
                    P(x, y, y < 5 ? dark : col);
                }
                P(3, 3, col); P(12, 3, col); P(3, 4, col); P(12, 4, col);
            } else if (piece === 'leggings') {
                for (let x = 4; x < 12; x++) { P(x, 3, col); P(x, 4, col); }
                for (let y = 5; y < 13; y++) {
                    P(4, y, col); P(5, y, col); P(6, y, dark);
                    P(9, y, dark); P(10, y, col); P(11, y, col);
                }
            } else {
                for (let y = 9; y < 13; y++) for (const x of [3, 4, 5, 10, 11, 12]) P(x, y, col);
                for (const x of [3, 4, 5, 6, 10, 11, 12, 13]) P(x, 13, dark);
            }
        };
    }
    const CUSTOM = {
        stick(ctx) { for (let i = 0; i < 9; i++) { px(ctx, 0, 0, 4 + i, 12 - i, 104, 78, 46); px(ctx, 0, 0, 5 + i, 12 - i, 82, 60, 34); } },
        apple(ctx) {
            for (let y = 5; y < 14; y++) for (let x = 3; x < 13; x++)
                if ((x - 7.5) * (x - 7.5) + (y - 9) * (y - 9) < 20) px(ctx, 0, 0, x, y, 196, 40, 32);
            px(ctx, 0, 0, 8, 2, 90, 62, 30); px(ctx, 0, 0, 8, 3, 90, 62, 30); px(ctx, 0, 0, 8, 4, 90, 62, 30);
            px(ctx, 0, 0, 10, 3, 74, 130, 48); px(ctx, 0, 0, 11, 3, 74, 130, 48);
        },
        coal(ctx) {
            for (let y = 5; y < 12; y++) for (let x = 4; x < 12; x++)
                if ((x - 7.5) * (x - 7.5) + (y - 8) * (y - 8) < 14) px(ctx, 0, 0, x, y, 45, 45, 48);
            px(ctx, 0, 0, 6, 6, 92, 92, 98); px(ctx, 0, 0, 7, 7, 74, 74, 80);
        },
        diamond(ctx) {
            const col = [108, 232, 220], light = [178, 250, 244];
            const rows = [[7, 8], [6, 9], [5, 10], [4, 11], [5, 10], [6, 9], [7, 8]];
            rows.forEach((rw, i) => {
                for (let x = rw[0]; x <= rw[1]; x++)
                    px(ctx, 0, 0, x, 4 + i, ...(x < 8 && i < 4 ? light : col));
            });
        }
    };
    const ingotPainter = col => ctx => {
        const dark = shadeC(col, 0.72), light = shadeC(col, 1.2);
        for (let y = 7; y < 11; y++) for (let x = 3; x < 13; x++) px(ctx, 0, 0, x, y, ...col);
        for (let x = 4; x < 14; x++) px(ctx, 0, 0, x, 6, ...light);
        for (let x = 3; x < 13; x++) px(ctx, 0, 0, x, 10, ...dark);
    };
    const chopPainter = (meat, edge) => ctx => {
        for (let y = 4; y < 12; y++) for (let x = 5; x < 13; x++) {
            const d = (x - 8.5) * (x - 8.5) / 1.6 + (y - 8) * (y - 8);
            if (d < 13) px(ctx, 0, 0, x, y, ...(d > 8 ? edge : meat));
        }
        px(ctx, 0, 0, 4, 10, 235, 230, 220); px(ctx, 0, 0, 3, 11, 235, 230, 220); // bone
    };
    CUSTOM.raw_porkchop = chopPainter([240, 150, 160], [214, 116, 130]);
    CUSTOM.cooked_porkchop = chopPainter([196, 124, 74], [150, 88, 48]);
    CUSTOM.rotten_flesh = chopPainter([140, 118, 88], [96, 82, 60]);
    CUSTOM.iron_ingot = ingotPainter(MAT_COLORS.iron);
    CUSTOM.gold_ingot = ingotPainter(MAT_COLORS.gold);
    CUSTOM.charcoal = ctx => {
        for (let y = 5; y < 12; y++) for (let x = 4; x < 12; x++)
            if ((x - 7.5) * (x - 7.5) + (y - 8) * (y - 8) < 14) px(ctx, 0, 0, x, y, 52, 40, 30);
        px(ctx, 0, 0, 6, 6, 96, 78, 58); px(ctx, 0, 0, 8, 9, 30, 22, 16);
    };
    CUSTOM.redstone = ctx => { // dust pile
        for (let x = 4; x < 12; x++) px(ctx, 0, 0, x, 11, 190, 40, 30);
        for (let x = 5; x < 11; x++) px(ctx, 0, 0, x, 10, 224, 58, 44);
        for (let x = 6; x < 10; x++) px(ctx, 0, 0, x, 9, 235, 80, 60);
        px(ctx, 0, 0, 7, 8, 255, 110, 90); px(ctx, 0, 0, 8, 8, 235, 80, 60);
    };
    // mining crack overlays: 4 stages of branching fractures, transparent background
    const crackPainter = stage => ctx => {
        const r = rng(300 + stage * 7);
        ctx.fillStyle = 'rgba(18,14,10,0.85)';
        for (let b2 = 0; b2 < 2 + stage * 2; b2++) {
            let X = 8 + (r() * 6 - 3), Y = 8 + (r() * 6 - 3);
            for (let i = 0; i < 4 + stage * 3; i++) {
                ctx.fillRect(Math.max(0, Math.min(15, X)) | 0, Math.max(0, Math.min(15, Y)) | 0, 1, 1);
                X += r() * 3 - 1.5; Y += r() * 3 - 1.5;
            }
        }
    };
    for (let n = 1; n <= 4; n++) CUSTOM['crack' + n] = crackPainter(n);
    for (const kind of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'])
        for (const mat in MAT_COLORS) CUSTOM[kind + '_' + mat] = toolPainter(kind, MAT_COLORS[mat]);
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots'])
        for (const mat of ['iron', 'gold', 'diamond']) CUSTOM[piece + '_' + mat] = armorPainter(piece, MAT_COLORS[mat]);

    const iconCache = {}, canvasCache = {};
    function tile(name) { // raw 16x16 canvas for a tile OR custom item art
        if (canvasCache[name]) return canvasCache[name];
        const c = document.createElement('canvas');
        c.width = c.height = SIZE;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        if (ART[name]) {                       // user-supplied art wins over everything
            const img = new Image();
            img.onload = () => {               // async: repaint the canvas when it lands
                ctx.clearRect(0, 0, SIZE, SIZE);
                ctx.drawImage(img, 0, 0, SIZE, SIZE);
                delete iconCache[name];        // force icon + texture refresh
                if (canvasCache[name]) canvasCache[name].__dirty = true;
            };
            img.src = ART[name];
            return canvasCache[name] = c;
        }
        if (CUSTOM[name]) CUSTOM[name](ctx);
        else if (TILES[name]) TILES[name](ctx, 0, 0);
        else TILES.white(ctx, 0, 0);
        return canvasCache[name] = c;
    }
    function icon(name) { return iconCache[name] || (iconCache[name] = tile(name).toDataURL()); }
    // Repaints one animated tile in place — used to flicker torch flames without
    // rebuilding the whole atlas. Returns false for tiles that aren't animated.
    function drawTile(name, ctx, x0, y0, frame) {
        if (!TILES[name]) return false;
        ctx.clearRect(x0, y0, SIZE, SIZE);
        TILES[name](ctx, x0, y0, frame);
        return true;
    }
    const ANIMATED = ['torch'];
    return { buildAtlas, icon, tile, drawTile, ORDER, GRID, SIZE, ANIMATED };
})();

/* ============================== ItemDB =================================== */
const ItemDB = (() => {
    const items = {};
    const def = o => { items[o.id] = o; };
    const B = (id, name, blockId, icon) => def({ id, name, type: 'Block', stack: 64, blockId, icon });
    B('grass_block', 'Grass Block', 1, 'grass_side');
    B('dirt', 'Dirt', 2, 'dirt');
    B('stone', 'Stone', 3, 'stone');
    B('sand', 'Sand', 4, 'sand');
    B('snow', 'Snow', 5, 'snow');
    B('plank', 'Planks', 6, 'plank');
    B('log', 'Log', 7, 'log_side');
    B('leaves', 'Leaves', 8, 'leaves');
    B('cobblestone', 'Cobblestone', 9, 'cobble');
    B('stone_bricks', 'Stone Bricks', 10, 'stonebrick');
    B('sandstone', 'Sandstone', 11, 'sandstone_side');
    B('gravel', 'Gravel', 12, 'gravel');
    B('coal_ore', 'Coal Ore', 13, 'coal_ore');
    B('iron_ore', 'Iron Ore', 14, 'iron_ore');
    B('gold_ore', 'Gold Ore', 15, 'gold_ore');
    B('diamond_ore', 'Diamond Ore', 16, 'diamond_ore');
    B('crafting_table', 'Crafting Table', 17, 'crafting_side');
    B('bookshelf', 'Bookshelf', 18, 'bookshelf');
    B('mossy_cobblestone', 'Mossy Cobblestone', 19, 'mossy');
    B('obsidian', 'Obsidian', 20, 'obsidian');
    B('furnace', 'Furnace', 21, 'furnace_front');
    B('glass', 'Glass', 22, 'glass');
    B('torch', 'Torch', 23, 'torch');
    B('redstone_ore', 'Redstone Ore', 24, 'redstone_ore');
    B('tall_grass', 'Grass', 25, 'tallgrass');
    B('flower_red', 'Poppy', 26, 'flower_red');
    B('flower_yellow', 'Dandelion', 27, 'flower_yellow');
    def({ id: 'stick', name: 'Stick', type: 'Material', stack: 64, icon: 'stick' });
    def({ id: 'coal', name: 'Coal', type: 'Material', stack: 64, icon: 'coal' });
    def({ id: 'charcoal', name: 'Charcoal', type: 'Material', stack: 64, icon: 'charcoal' });
    def({ id: 'redstone', name: 'Redstone Dust', type: 'Material', stack: 64, icon: 'redstone' });
    def({ id: 'iron_ingot', name: 'Iron Ingot', type: 'Material', stack: 64, icon: 'iron_ingot' });
    def({ id: 'gold_ingot', name: 'Gold Ingot', type: 'Material', stack: 64, icon: 'gold_ingot' });
    def({ id: 'diamond', name: 'Diamond', type: 'Material', stack: 64, icon: 'diamond' });
    def({ id: 'apple', name: 'Apple', type: 'Consumable', stack: 16, icon: 'apple', heal: 4 });
    def({ id: 'raw_porkchop', name: 'Raw Porkchop', type: 'Consumable', stack: 64, icon: 'raw_porkchop', heal: 2 });
    def({ id: 'cooked_porkchop', name: 'Cooked Porkchop', type: 'Consumable', stack: 64, icon: 'cooked_porkchop', heal: 8 });
    def({ id: 'rotten_flesh', name: 'Rotten Flesh', type: 'Consumable', stack: 64, icon: 'rotten_flesh', heal: 1 });
    // tools: 5 kinds x 5 material tiers (wood/stone/iron/gold/diamond)
    const CAP = s => s[0].toUpperCase() + s.slice(1);
    const SWORD_DMG = [4, 5, 6, 4, 7];      // MC-ish per tier
    const DURABILITY = [59, 131, 250, 32, 1561]; // real MC tool durabilities per tier
    const MATS = ['wood', 'stone', 'iron', 'gold', 'diamond'];
    MATS.forEach((mat, tier) => {
        for (const kind of ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']) def({
            id: kind + '_' + mat, name: CAP(mat) + ' ' + CAP(kind), type: 'Tool', stack: 1,
            tool: kind, tier, damage: kind === 'sword' ? SWORD_DMG[tier] : tier + 2,
            dur: DURABILITY[tier], icon: kind + '_' + mat
        });
    });
    // armor: real MC protection points per piece
    const ARMOR = { iron: [2, 6, 5, 2], gold: [2, 5, 3, 1], diamond: [3, 8, 6, 3] };
    for (const mat of ['iron', 'gold', 'diamond'])
        ['helmet', 'chestplate', 'leggings', 'boots'].forEach((piece, slot) => def({
            id: piece + '_' + mat, name: CAP(mat) + ' ' + CAP(piece), type: 'Armor', stack: 1,
            armor: ARMOR[mat][slot], armorSlot: slot, icon: piece + '_' + mat
        }));
    const byBlock = {};
    for (const id in items) if (items[id].blockId) byBlock[items[id].blockId] = id;
    return {
        get: id => items[id] || null,
        maxStack: id => (items[id] ? items[id].stack : 64),
        byBlock,
        count: () => Object.keys(items).length,
        list: () => Object.keys(items),      // ordered — powers the creative catalog
        /** Make a fresh stack (tools get full durability). */
        mk: (id, n) => {
            const it = items[id];
            const st = { id, n };
            if (it && it.dur !== undefined) st.dur = it.dur;
            return st;
        },
        iconURI: id => TexGen.icon(items[id] ? items[id].icon : 'white')
    };
})();

/* ========================== InventoryManager ============================== */
// 27 main + 9 hotbar + 4 armor + 1 off-hand + 3x3 crafting grid (the personal
// screen only exposes a 2x2 window of it) + 1 output.
class InventoryManager {
    constructor() {
        this.main = Array(27).fill(null);
        this.hotbar = Array(9).fill(null);
        this.armor = Array(4).fill(null);
        this.offhand = Array(1).fill(null);
        this.craft = Array(9).fill(null);      // 3x3 row-major
        this.craftOut = Array(1).fill(null);
        this.onChange = () => {};
    }
    /** Stacking + overflow: top up matching stacks (hotbar first), then spill. */
    addItem(id, n) {
        const max = ItemDB.maxStack(id);
        for (const L of [this.hotbar, this.main])
            for (let i = 0; i < L.length && n > 0; i++) {
                const s = L[i];
                if (s && s.id === id && s.n < max) { const t = Math.min(max - s.n, n); s.n += t; n -= t; }
            }
        for (const L of [this.hotbar, this.main])
            for (let i = 0; i < L.length && n > 0; i++)
                if (!L[i]) { const t = Math.min(max, n); L[i] = ItemDB.mk(id, t); n -= t; }
        this.onChange();
        return n;
    }
    canPlace(section, idx, id) {
        if (section === 'craftOut') return false;
        if (section === 'armor') {
            const it = ItemDB.get(id);
            return !!it && it.type === 'Armor' && it.armorSlot === idx;
        }
        return true;
    }
    section(name) { return this[name]; }
    canFit(id, n) {
        const max = ItemDB.maxStack(id);
        let cap = 0;
        for (const L of [this.hotbar, this.main]) for (const s of L)
            cap += s ? (s.id === id ? max - s.n : 0) : max;
        return cap >= n;
    }
    serialize() { // [id, count] or [id, count, durability] for worn tools
        const pack = L => L.map(s => s ? (s.dur !== undefined ? [s.id, s.n, s.dur] : [s.id, s.n]) : 0);
        return { main: pack(this.main), hotbar: pack(this.hotbar), armor: pack(this.armor), offhand: pack(this.offhand) };
    }
    load(d) {
        // unknown item ids (older saves) collapse to empty; tools without a saved
        // durability (older saves) are backfilled to full
        const un = (L, src) => {
            for (let i = 0; i < L.length; i++) {
                const e = src && src[i], it = e && ItemDB.get(e[0]);
                if (!it) { L[i] = null; continue; }
                const st = { id: e[0], n: e[1] };
                if (it.dur !== undefined) st.dur = e[2] !== undefined ? e[2] : it.dur;
                L[i] = st;
            }
        };
        // NOTE: a missing/!null payload means "fresh start" — every section must be
        // WIPED, not left alone, or a new world inherits the last world's inventory.
        const src = d || {};
        un(this.main, src.main); un(this.hotbar, src.hotbar);
        un(this.armor, src.armor); un(this.offhand, src.offhand);
        this.craft.fill(null);          // crafting grid + output never carry over
        this.craftOut[0] = null;
        this.onChange();
    }
}

/* =============================== Crafting ================================= */
// 3x3 shaped (position-independent via bounding-box normalization) + shapeless.
// Recipes are real Minecraft shapes; "adapted" = tweaked because there is no
// smelting yet (stone bricks from cobble, bookshelf uses sticks).
const Crafting = (() => {
    const shaped = [], shapeless = [];
    function S(rows, map, outId, outN) {
        const h = rows.length, w = rows[0].length, cells = [];
        for (const row of rows) for (const ch of row) cells.push(ch === ' ' ? null : map[ch]);
        shaped.push({ w, h, cells, out: [outId, outN] });
    }
    function SL(ids, outId, outN) {
        shapeless.push({ key: ids.slice().sort().join('+'), out: [outId, outN] });
    }
    // --- basics & blocks ---
    SL(['log'], 'plank', 4);
    S(['P', 'P'], { P: 'plank' }, 'stick', 4);
    S(['PP', 'PP'], { P: 'plank' }, 'crafting_table', 1);
    S(['CCC', 'C C', 'CCC'], { C: 'cobblestone' }, 'furnace', 1);
    S(['CC', 'CC'], { C: 'cobblestone' }, 'stone_bricks', 4);   // adapted
    S(['dd', 'dd'], { d: 'sand' }, 'sandstone', 1);
    S(['PPP', 'SSS', 'PPP'], { P: 'plank', S: 'stick' }, 'bookshelf', 1); // adapted
    SL(['cobblestone', 'leaves'], 'mossy_cobblestone', 1);
    S(['C', 'S'], { C: 'coal', S: 'stick' }, 'torch', 4);      // coal above stick -> 4 torches
    S(['C', 'S'], { C: 'charcoal', S: 'stick' }, 'torch', 4);  // charcoal variant
    // --- tools (real MC shapes) for every material tier ---
    const TM = { wood: 'plank', stone: 'cobblestone', iron: 'iron_ingot', gold: 'gold_ingot', diamond: 'diamond' };
    for (const mat in TM) {
        const mp = { M: TM[mat], S: 'stick' };
        S(['MMM', ' S ', ' S '], mp, 'pickaxe_' + mat, 1);
        S(['MM', 'MS', ' S'], mp, 'axe_' + mat, 1);
        S(['M', 'S', 'S'], mp, 'shovel_' + mat, 1);
        S(['M', 'M', 'S'], mp, 'sword_' + mat, 1);
        S(['MM', ' S', ' S'], mp, 'hoe_' + mat, 1);
    }
    // --- armor (real MC shapes) ---
    const AM = { iron: 'iron_ingot', gold: 'gold_ingot', diamond: 'diamond' };
    for (const mat in AM) {
        const mp = { M: AM[mat] };
        S(['MMM', 'M M'], mp, 'helmet_' + mat, 1);
        S(['M M', 'MMM', 'MMM'], mp, 'chestplate_' + mat, 1);
        S(['MMM', 'M M', 'M M'], mp, 'leggings_' + mat, 1);
        S(['M M', 'M M'], mp, 'boots_' + mat, 1);
    }
    /** grid: 9 slots row-major 3x3 -> {id, n} | null */
    function match(grid) {
        let x0 = 3, y0 = 3, x1 = -1, y1 = -1;
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (grid[y * 3 + x]) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        if (x1 < 0) return null;
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        outer: for (const r of shaped) {
            if (r.w !== w || r.h !== h) continue;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const s = grid[(y0 + y) * 3 + (x0 + x)];
                if ((s ? s.id : null) !== r.cells[y * w + x]) continue outer;
            }
            return { id: r.out[0], n: r.out[1] };
        }
        const ids = [];
        for (const s of grid) if (s) ids.push(s.id);
        const key = ids.sort().join('+');
        for (const r of shapeless) if (r.key === key) return { id: r.out[0], n: r.out[1] };
        return null;
    }
    return { match, count: () => shaped.length + shapeless.length };
})();

/* =============================== Smelting ================================= */
// Furnace rules: 10s per item, 1 coal = 8 items (80s burn). Un-adapts the ore
// chain: iron/gold ORE blocks now drop themselves and smelt into ingots here.
const Smelting = (() => {
    const SMELT = { iron_ore: 'iron_ingot', gold_ore: 'gold_ingot', sand: 'glass',
                    cobblestone: 'stone', log: 'charcoal', raw_porkchop: 'cooked_porkchop' };
    const FUELS = { coal: 80, charcoal: 80, log: 15, plank: 15, stick: 5 }; // burn seconds
    return {
        TIME: 10,
        result: id => SMELT[id] || null,
        canSmelt: id => !!SMELT[id],
        fuelTime: id => FUELS[id] || 0,
        isFuel: id => !!FUELS[id]
    };
})();

/* ============================= InventoryUI ================================ */
// Modes: 'player' (2x2 crafting window + armor), 'table' (full 3x3), and
// 'furnace' (external container: input/fuel/output + bars). Same drag-and-drop
// semantics everywhere; furnace slots live on the container, not the player.
class InventoryUI {
    constructor(opts) { // {wrap, panel, cursorEl, tipEl, onClose, onToast}
        this.o = opts;
        this.player = null;
        this.mode = 'player';
        this.cursor = null;
        this.container = null;   // furnace state object when mode === 'furnace'
        opts.panel.addEventListener('mousedown', e => {
            const slot = e.target.closest('.slot');
            if (!slot || !this.player) return;
            e.preventDefault();
            this.handle(slot.dataset.s, +slot.dataset.i, e.button, e.shiftKey);
        });
        opts.panel.addEventListener('contextmenu', e => e.preventDefault());
        window.addEventListener('mousemove', e => {
            this.o.cursorEl.style.left = (e.clientX + 6) + 'px';
            this.o.cursorEl.style.top = (e.clientY + 6) + 'px';
            this.tooltipFor(e);
        });
    }
    get inv() { return this.player ? this.player.inv : null; }

    static slotHtml(s, i) {
        return '<div class="slot" data-s="' + s + '" data-i="' + i +
            '"><img draggable="false"><span class="cnt"></span><b class="durbar"><i></i></b></div>';
    }
    static buildPanel(panel) {
        const slot = InventoryUI.slotHtml;
        let h = '<div class="invTitle"></div><div class="invTop"><div class="invArmor">';
        for (let i = 0; i < 4; i++) h += slot('armor', i);
        h += slot('offhand', 0) + '</div><div class="invCraft"><div class="craftGrid"></div>' +
             '<div class="craftArrow">&#10132;</div>' + slot('craftOut', 0) + '</div></div>' +
             '<div class="furnGrid hidden"><div class="furnCol">' + slot('fIn', 0) +
             '<div class="fuelBar"><i></i></div>' + slot('fFuel', 0) + '</div>' +
             '<div class="progBar"><i></i></div>' + slot('fOut', 0) + '</div>' +
             '<div class="catTitle hidden">Creative catalog — left: stack · right: one · click with item: destroy</div>' +
             '<div class="invCatalog hidden"></div><div class="invMain">';
        for (let i = 0; i < 27; i++) h += slot('main', i);
        h += '</div><div class="invHotbar">';
        for (let i = 0; i < 9; i++) h += slot('hotbar', i);
        h += '</div><div class="invHint">left: pick/place/swap &nbsp; right: half/one &nbsp; shift: quick move / equip / craft-all</div>';
        panel.innerHTML = h;
    }
    /** mode 'player' shows craft indices [0,1,3,4] as a 2x2; 'table' shows all 9.
     *  creative=true adds the item catalog (every item, free). */
    open(player, label, mode, creative, container) {
        this.player = player;
        this.mode = mode || 'player';
        this.creative = !!creative;
        this.container = container || null;
        const grid = this.o.panel.querySelector('.craftGrid');
        const idxs = this.mode === 'table' ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
                   : this.mode === 'furnace' ? [] : [0, 1, 3, 4];
        grid.style.gridTemplateColumns = 'repeat(' + (this.mode === 'table' ? 3 : 2) + ', 40px)';
        grid.innerHTML = idxs.map(i => InventoryUI.slotHtml('craft', i)).join('');
        const cat = this.o.panel.querySelector('.invCatalog');
        this.o.panel.querySelector('.catTitle').classList.toggle('hidden', !this.creative);
        cat.classList.toggle('hidden', !this.creative);
        cat.innerHTML = this.creative
            ? ItemDB.list().map((id, i) => InventoryUI.slotHtml('catalog', i)).join('') : '';
        this.o.panel.classList.toggle('mode-table', this.mode === 'table');
        this.o.panel.classList.toggle('mode-furnace', this.mode === 'furnace');
        this.o.panel.querySelector('.furnGrid').classList.toggle('hidden', this.mode !== 'furnace');
        this.o.panel.querySelector('.invTitle').textContent = label;
        this.o.wrap.classList.remove('hidden');
        this.recompute();
        this.updateBars();
        this.refresh();
    }
    /** Furnace progress + fuel bars (called each frame by the game while open). */
    updateBars() {
        if (this.mode !== 'furnace' || !this.container) return;
        const f = this.container;
        const pb = this.o.panel.querySelector('.progBar i');
        const fb = this.o.panel.querySelector('.fuelBar i');
        if (pb) pb.style.width = Math.min(100, f.prog / Smelting.TIME * 100) + '%';
        if (fb) fb.style.width = (f.burnMax > 0 ? Math.max(0, Math.min(1, f.burn / f.burnMax)) * 100 : 0) + '%';
    }
    close() {
        if (!this.player) return;
        const inv = this.inv;
        for (let i = 0; i < 9; i++) if (inv.craft[i]) {   // grid contents go back to the bag
            if (inv.addItem(inv.craft[i].id, inv.craft[i].n)) this.o.onToast('Inventory full — items lost');
            inv.craft[i] = null;
        }
        if (this.cursor) {
            if (inv.addItem(this.cursor.id, this.cursor.n)) this.o.onToast('Inventory full — items lost');
            this.cursor = null;
        }
        inv.craftOut[0] = null;
        this.o.wrap.classList.add('hidden');
        this.o.tipEl.classList.add('hidden');
        this.o.cursorEl.classList.add('hidden');
        const p = this.player;
        this.player = null;
        inv.onChange();
        this.o.onClose(p);
    }

    /* ---------------- drag & drop semantics ---------------- */
    handle(sec, i, button, shift) {
        if (sec === 'catalog') this.catalogClick(i, button, shift);
        else if (shift) this.shiftClick(sec, i);
        else if (button === 2) this.rightClick(sec, i);
        else if (button === 0) this.leftClick(sec, i);
        if (sec === 'craft' || sec === 'craftOut') this.recompute();
        this.inv.onChange();
        this.refresh();
    }
    /** Creative catalog: left = full stack on cursor, right = one, shift = straight
     *  to inventory; clicking with a held stack destroys it (MC creative). */
    catalogClick(i, button, shift) {
        const id = ItemDB.list()[i];
        if (!id) return;
        if (this.cursor) { this.cursor = null; return; }
        if (shift) { this.inv.addItem(id, ItemDB.maxStack(id)); return; }
        this.cursor = ItemDB.mk(id, button === 2 ? 1 : ItemDB.maxStack(id));
    }
    /** Section arrays live on the player inventory OR the open container. */
    sectionArr(sec) {
        if (sec === 'fIn' || sec === 'fFuel' || sec === 'fOut')
            return this.container ? this.container.slots[sec] : [null];
        return this.inv.section(sec);
    }
    canPlaceIn(sec, i, id) {
        if (sec === 'fOut') return false;                 // output is take-only
        if (sec === 'fFuel') return Smelting.isFuel(id);  // fuel slot accepts fuels only
        if (sec === 'fIn') return true;
        return this.inv.canPlace(sec, i, id);
    }
    leftClick(sec, i) {
        const L = this.sectionArr(sec), s = L[i];
        if (sec === 'craftOut') return this.takeCraft(false);
        if (!this.cursor) { if (s) { this.cursor = s; L[i] = null; } return; }
        if (!this.canPlaceIn(sec, i, this.cursor.id)) return;
        if (!s) { L[i] = this.cursor; this.cursor = null; return; }
        if (s.id === this.cursor.id) {
            const max = ItemDB.maxStack(s.id), t = Math.min(max - s.n, this.cursor.n);
            s.n += t; this.cursor.n -= t;
            if (this.cursor.n <= 0) this.cursor = null;
            return;
        }
        L[i] = this.cursor; this.cursor = s;
    }
    rightClick(sec, i) {
        const L = this.sectionArr(sec), s = L[i];
        if (sec === 'craftOut') return this.takeCraft(false);
        if (!this.cursor) {
            if (!s) return;
            const take = Math.ceil(s.n / 2);
            this.cursor = { id: s.id, n: take };
            if (s.dur !== undefined) this.cursor.dur = s.dur;
            s.n -= take;
            if (s.n <= 0) L[i] = null;
            return;
        }
        if (!this.canPlaceIn(sec, i, this.cursor.id)) return;
        if (!s) {
            L[i] = { id: this.cursor.id, n: 1 };
            if (this.cursor.dur !== undefined) L[i].dur = this.cursor.dur; // tools carry wear
        }
        else if (s.id === this.cursor.id && s.n < ItemDB.maxStack(s.id)) s.n += 1;
        else return;
        this.cursor.n -= 1;
        if (this.cursor.n <= 0) this.cursor = null;
    }
    shiftClick(sec, i) {
        const inv = this.inv;
        if (sec === 'craftOut') return this.takeCraft(true);
        const L = this.sectionArr(sec), s = L[i];
        if (!s) return;
        // furnace: shift-click routes fuels to the fuel slot, smeltables to input
        if (this.mode === 'furnace' && (sec === 'main' || sec === 'hotbar')) {
            const dst = Smelting.isFuel(s.id) ? this.sectionArr('fFuel')
                      : Smelting.canSmelt(s.id) ? this.sectionArr('fIn') : null;
            if (dst) {
                const t = dst[0];
                if (!t) { dst[0] = s; L[i] = null; return; }
                if (t.id === s.id && t.n < ItemDB.maxStack(s.id)) {
                    const c = Math.min(ItemDB.maxStack(s.id) - t.n, s.n);
                    t.n += c; s.n -= c;
                    if (s.n <= 0) L[i] = null;
                    return;
                }
            }
        }
        const it = ItemDB.get(s.id);
        if (it && it.type === 'Armor' && sec !== 'armor' && !inv.armor[it.armorSlot]) {
            inv.armor[it.armorSlot] = s; L[i] = null; return;   // auto-equip
        }
        const target = sec === 'main' ? [inv.hotbar] : [inv.main];
        L[i] = null;
        let n = s.n;
        for (const T of target) {
            const max = ItemDB.maxStack(s.id);
            for (let j = 0; j < T.length && n > 0; j++) {
                const t = T[j];
                if (t && t.id === s.id && t.n < max) { const c = Math.min(max - t.n, n); t.n += c; n -= c; }
            }
            for (let j = 0; j < T.length && n > 0; j++)
                if (!T[j]) { const c = Math.min(ItemDB.maxStack(s.id), n); T[j] = { id: s.id, n: c }; n -= c; }
        }
        if (n > 0) L[i] = { id: s.id, n };
    }
    takeCraft(all) {
        const inv = this.inv;
        let guard = 0;
        do {
            const out = Crafting.match(inv.craft);
            if (!out) break;
            if (all) {
                if (!inv.canFit(out.id, out.n)) break;
                inv.addItem(out.id, out.n);
            } else {
                if (!this.cursor) this.cursor = ItemDB.mk(out.id, out.n); // fresh durability
                else if (this.cursor.id === out.id && this.cursor.n + out.n <= ItemDB.maxStack(out.id)) this.cursor.n += out.n;
                else break;
            }
            for (let i = 0; i < 9; i++) if (inv.craft[i] && --inv.craft[i].n <= 0) inv.craft[i] = null;
        } while (all && ++guard < 64);
        this.recompute();
    }
    recompute() { if (this.inv) this.inv.craftOut[0] = Crafting.match(this.inv.craft); }

    /* ---------------- rendering ---------------- */
    /** Resolve what a slot element shows (catalog slots are virtual full stacks). */
    stackAt(el) {
        if (el.dataset.s === 'catalog') {
            const id = ItemDB.list()[+el.dataset.i];
            return id ? { id, n: 1 } : null;
        }
        return this.sectionArr(el.dataset.s)[+el.dataset.i];
    }
    refresh() {
        if (!this.player) return;
        this.o.panel.querySelectorAll('.slot').forEach(el => {
            InventoryUI.renderSlot(el, this.stackAt(el));
        });
        const c = this.o.cursorEl;
        if (this.cursor) {
            c.classList.remove('hidden');
            c.querySelector('img').src = ItemDB.iconURI(this.cursor.id);
            c.querySelector('.cnt').textContent = this.cursor.n > 1 ? this.cursor.n : '';
        } else c.classList.add('hidden');
    }
    static renderSlot(el, s) {
        const img = el.querySelector('img'), cnt = el.querySelector('.cnt');
        if (s) { img.src = ItemDB.iconURI(s.id); img.style.display = 'block'; cnt.textContent = s.n > 1 ? s.n : ''; }
        else { img.style.display = 'none'; cnt.textContent = ''; }
        const bar = el.querySelector('.durbar');
        if (bar) { // tool durability strip (green -> yellow -> red)
            const it = s && ItemDB.get(s.id);
            if (s && it && it.dur && s.dur !== undefined && s.dur < it.dur) {
                const f = s.dur / it.dur;
                bar.style.display = 'block';
                bar.firstElementChild.style.width = (f * 100) + '%';
                bar.firstElementChild.style.background = f > 0.5 ? '#5c5' : f > 0.25 ? '#cc4' : '#c33';
            } else bar.style.display = 'none';
        }
    }
    tooltipFor(e) {
        const tip = this.o.tipEl;
        if (!this.player || this.cursor) { tip.classList.add('hidden'); return; }
        const slot = e.target && e.target.closest ? e.target.closest('#invPanel .slot') : null;
        const s = slot ? this.stackAt(slot) : null;
        if (!s) { tip.classList.add('hidden'); return; }
        const it = ItemDB.get(s.id);
        if (!it) { tip.classList.add('hidden'); return; }
        let h = '<b>' + it.name + '</b><br><span class="dim">' + it.type + (it.tool ? ' · tier ' + (it.tier + 1) : '') + '</span>';
        if (it.armor) h += '<br>+' + it.armor + ' armor';
        if (it.damage) h += '<br>' + it.damage + ' damage';
        if (it.heal) h += '<br>restores ' + it.heal + ' health';
        if (it.dur && s.dur !== undefined) h += '<br>durability ' + s.dur + ' / ' + it.dur;
        if (slot.dataset.s !== 'catalog') h += '<br><span class="dim">' + s.n + ' / ' + it.stack + '</span>';
        tip.innerHTML = h;
        tip.classList.remove('hidden');
        tip.style.left = Math.min(e.clientX + 12, innerWidth - 160) + 'px';
        tip.style.top = (e.clientY + 12) + 'px';
    }
    static renderHotbar(el, inv, active) {
        if (el.childElementCount !== 9) {
            el.innerHTML = '';
            for (let i = 0; i < 9; i++) el.insertAdjacentHTML('beforeend',
                '<div class="slot hb" data-i="' + i + '"><img draggable="false"><span class="cnt"></span><b class="durbar"><i></i></b></div>');
        }
        for (let i = 0; i < 9; i++) {
            const s = el.children[i];
            s.classList.toggle('active', i === active);
            InventoryUI.renderSlot(s, inv.hotbar[i]);
        }
    }
}

/* ============================ DataSerializer ============================== */
const DataSerializer = {
    encodeChunks(edits, binary) {
        if (!binary) return 'J' + JSON.stringify(edits);
        const bytes = [];
        const u16 = v => { bytes.push(v & 255, (v >> 8) & 255); };
        u16(edits.length);
        for (const [key, list] of edits) {
            bytes.push(key.length);
            for (let i = 0; i < key.length; i++) bytes.push(key.charCodeAt(i) & 255);
            u16(list.length);
            for (const [li, id] of list) { u16(li); bytes.push(id & 255); }
        }
        let s = '';
        for (let i = 0; i < bytes.length; i += 4096)
            s += String.fromCharCode.apply(null, bytes.slice(i, i + 4096));
        return 'B' + btoa(s);
    },
    decodeChunks(str) {
        if (!str) return [];
        if (str[0] === 'J') return JSON.parse(str.slice(1));
        const raw = atob(str.slice(1));
        let p = 0;
        const u8 = () => raw.charCodeAt(p++) & 255;
        const u16 = () => u8() | (u8() << 8);
        const out = [];
        const nChunks = u16();
        for (let c = 0; c < nChunks; c++) {
            const kl = u8();
            let key = '';
            for (let i = 0; i < kl; i++) key += raw[p++];
            const n = u16(), list = [];
            for (let i = 0; i < n; i++) { const li = u16(); list.push([li, u8()]); }
            out.push([key, list]);
        }
        return out;
    }
};

/* ============================= SaveManager ================================ */
// Keys mirror Saves/<World>/{metadata,player,chunks}; independently loadable.
class SaveManager {
    constructor(opts) { // {getState()->{meta,player,chunks}, binary, onToast}
        this.o = opts;
        this.prefix = 'voxel/';
        this._auto = null;
        this._saving = false;
        try { localStorage.setItem('voxel/__t', '1'); localStorage.removeItem('voxel/__t'); this.store = localStorage; }
        catch (e) {
            const m = new Map();
            this.store = { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, v),
                           removeItem: k => m.delete(k), get length() { return m.size; }, key: i => [...m.keys()][i] };
            opts.onToast('localStorage unavailable — saves last only this session');
        }
    }
    listWorlds() {
        const out = [];
        for (let i = 0; i < this.store.length; i++) {
            const k = this.store.key(i);
            if (k && k.indexOf(this.prefix) === 0 && k.slice(-9) === '/metadata') {
                try { out.push(JSON.parse(this.store.getItem(k))); } catch (e) {}
            }
        }
        return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }
    exists(name) { return this.store.getItem(this.prefix + name + '/metadata') !== null; }
    /** Async save: yields between the three files so no frame is dropped. */
    async save() {
        if (this._saving) return;
        this._saving = true;
        try {
            const tick = () => new Promise(r => setTimeout(r, 0));
            const st = this.o.getState();
            const baseK = this.prefix + st.meta.worldName;
            this.store.setItem(baseK + '/metadata', JSON.stringify(st.meta)); await tick();
            this.store.setItem(baseK + '/player', JSON.stringify(st.player)); await tick();
            const enc = DataSerializer.encodeChunks(st.chunks, !!this.o.binary); await tick();
            this.store.setItem(baseK + '/chunks', enc);
            if (st.furnaces) this.store.setItem(baseK + '/furnaces', JSON.stringify(st.furnaces));
        } finally { this._saving = false; }
    }
    load(name) {
        const baseK = this.prefix + name;
        const parse = (k, d) => { try { const v = this.store.getItem(baseK + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
        return {
            meta: parse('/metadata', null),
            player: parse('/player', null),
            chunks: DataSerializer.decodeChunks(this.store.getItem(baseK + '/chunks')),
            furnaces: parse('/furnaces', [])
        };
    }
    deleteWorld(name) {
        for (const f of ['/metadata', '/player', '/chunks', '/furnaces']) this.store.removeItem(this.prefix + name + f);
    }
    startAutoSave(ms) {
        this.stopAutoSave();
        this._auto = setInterval(() => { this.save().then(() => this.o.onToast('Autosaved')); }, ms);
    }
    stopAutoSave() { if (this._auto) { clearInterval(this._auto); this._auto = null; } }
}
