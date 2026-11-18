/**
 * Authors the idle screen's own Lottie animations as JSON sources:
 *
 *   node scripts/generate-idle-lottie-assets.js
 *
 * Writes src/public/assets/lottie/idle-src/<name>.json. Then run
 * `node scripts/build-idle-lottie-slots.js --force` to pack them into the
 * slot files under assets/lottie/idle/.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  COLOR,
  EASE_OUT,
  OVERSHOOT,
  anim,
  animation,
  ellipse,
  fill,
  group,
  hex,
  layer,
  part,
  path: bezier,
  rect,
  stroke,
  trim,
} = require('./lib/lottie-kit');

const OUT_DIR = path.resolve(__dirname, '..', 'src', 'public', 'assets', 'lottie', 'idle-src');
const FRAMES = 120; // 4 s at 30 fps

/** Pops in at `start`, holds, then shrinks away before the loop restarts. */
const popScale = (start, end = 104) =>
  anim([
    [0, [0, 0]],
    [start, [0, 0], OVERSHOOT],
    [start + 12, [100, 100]],
    [end, [100, 100]],
    [end + 10, [0, 0]],
  ]);

const fadeLoop = (start, end = 104) =>
  anim([
    [0, 0],
    [start, 0],
    [start + 8, 100],
    [end, 100],
    [end + 10, 0],
  ]);

const textLines = (width, top, count, gap = 18, color = COLOR.paperLine) =>
  Array.from({ length: count }, (_, i) =>
    part(
      [rect([i === count - 1 ? width * 0.6 : width, 8], [i === count - 1 ? -width * 0.2 : 0, top + i * gap], 4)],
      [fill(color)],
    ),
  );

// ── Welcome: the kiosk with print, copy, and scan badges ─────────────────
function welcome() {
  const kioskBody = group([
    part([rect([240, 210], [0, 0], 28)], [fill(COLOR.indigo), stroke(COLOR.lavender, 6)]),
    part([rect([170, 74], [0, -42], 14)], [fill(COLOR.deepSpace)]),
    part([rect([90, 10], [-20, -52], 5)], [fill(COLOR.mint)]),
    part([rect([54, 10], [-38, -32], 5)], [fill(COLOR.lavender, 0.7)]),
    part([rect([180, 16], [0, 72], 8)], [fill(COLOR.deepSpace)]),
  ]);

  const paper = group([
    part([rect([132, 150], [0, 0], 8)], [fill(COLOR.white)]),
    ...textLines(92, -40, 4),
  ]);

  const badge = (color, glyph, x, y, start) =>
    layer(
      `Badge ${x}`,
      [group([part([ellipse([96, 96])], [fill(color)]), ...glyph])],
      { position: [x, y], scale: popScale(start) },
    );

  const ink = (geometry) => part(geometry, [stroke(COLOR.deepSpace, 7)]);
  const printGlyph = [
    ink([rect([34, 44], [0, 0], 4)]),
    ink([bezier([[-8, -6], [8, -6]])]),
    ink([bezier([[-8, 6], [8, 6]])]),
  ];
  const copyGlyph = [
    ink([rect([30, 38], [-7, -6], 4)]),
    part([rect([30, 38], [7, 6], 4)], [fill(COLOR.mint), stroke(COLOR.deepSpace, 7)]),
  ];
  const scanGlyph = [
    ink([rect([42, 34], [0, 0], 5)]),
    part([bezier([[-28, 0], [28, 0]])], [stroke(COLOR.indigo, 7)]),
  ];

  return animation('PrintBit — Welcome', FRAMES, [
    layer('Paper', [paper], {
      position: anim([
        [0, [256, 320]],
        [44, [256, 320], EASE_OUT],
        [80, [256, 430]],
        [104, [256, 430]],
        [114, [256, 320]],
      ]),
      opacity: anim([
        [0, 0],
        [44, 0],
        [50, 100],
        [104, 100],
        [112, 0],
      ]),
    }),
    layer('Kiosk', [kioskBody], { position: [256, 300] }),
    badge(COLOR.pink, printGlyph, 136, 128, 8),
    badge(COLOR.mint, copyGlyph, 256, 96, 18),
    badge(COLOR.peach, scanGlyph, 376, 128, 28),
  ]);
}

// ── Supported files: PDF, Word, and image cards fan out ──────────────────
function supportedFiles() {
  const card = (accent, content) =>
    group([
      part([rect([140, 180], [0, 0], 14)], [fill(COLOR.white)]),
      part([rect([64, 24], [-28, -62], 12)], [fill(accent)]),
      ...content,
    ]);

  const imageContent = [
    part([rect([108, 86], [0, 18], 8)], [fill(COLOR.mint, 0.35)]),
    part([ellipse([22, 22], [26, -6])], [fill(COLOR.peach)]),
    part(
      [bezier([[-50, 56], [-14, 6], [10, 34], [24, 18], [50, 56]], true)],
      [fill(hex('#4fb98a'))],
    ),
  ];

  const fan = (x, y, rotation, delay) => ({
    position: anim([
      [0, [256, 270]],
      [10 + delay, [256, 270], EASE_OUT],
      [34 + delay, [x, y]],
      [92, [x, y]],
      [112, [256, 270]],
    ]),
    rotation: anim([
      [0, 0],
      [10 + delay, 0, EASE_OUT],
      [34 + delay, rotation],
      [92, rotation],
      [112, 0],
    ]),
    scale: anim([
      [0, [88, 88]],
      [10 + delay, [88, 88], EASE_OUT],
      [34 + delay, [100, 100]],
      [92, [100, 100]],
      [112, [88, 88]],
    ]),
  });

  return animation('PrintBit — Supported files', FRAMES, [
    layer('Image', [card(COLOR.mint, imageContent)], fan(372, 284, 12, 6)),
    layer('PDF', [card(COLOR.pink, textLines(100, -20, 5))], fan(140, 284, -12, 6)),
    layer('Word', [card(COLOR.indigo, textLines(100, -20, 5))], fan(256, 246, 0, 0)),
  ]);
}

// ── Privacy: the file is cleared, a shield checks, the receipt goes to the phone
function privacyReceipt() {
  const doc = group([
    part([rect([130, 166], [0, 0], 12)], [fill(COLOR.white)]),
    ...textLines(90, -46, 5),
  ]);

  const shieldOutline = bezier(
    [
      [0, -86],
      [74, -60],
      [74, 4, [0, 0], [0, 46]],
      [0, 92, [42, -16], [-42, -16]],
      [-74, 4, [0, 46], [0, 0]],
      [-74, -60],
    ],
    true,
  );
  const shield = group([
    part([shieldOutline], [fill(COLOR.indigo), stroke(COLOR.lavender, 7)]),
    part(
      [bezier([[-30, 2], [-8, 26], [32, -22]]), trim(anim([[0, 0], [48, 0, EASE_OUT], [64, 100]]))],
      [stroke(COLOR.white, 14)],
    ),
  ]);

  const phone = group([
    part([rect([104, 184], [0, 0], 20)], [fill(COLOR.deepSpace), stroke(COLOR.lavender, 6)]),
    part([rect([30, 6], [0, -76], 3)], [fill(COLOR.lavender, 0.6)]),
  ]);

  const receipt = group([
    part([rect([60, 78], [0, 0], 6)], [fill(COLOR.white)]),
    ...textLines(38, -20, 3, 14),
    part([rect([38, 8], [0, 26], 4)], [fill(COLOR.mint)]),
  ]);

  return animation('PrintBit — Privacy', FRAMES, [
    layer('Phone', [phone], {
      position: [392, 268],
      opacity: fadeLoop(56),
    }),
    layer('Document', [doc], {
      position: [256, 256],
      scale: anim([
        [0, [0, 0], OVERSHOOT],
        [12, [100, 100]],
        [22, [100, 100]],
        [40, [0, 0]],
      ]),
      opacity: anim([
        [0, 100],
        [26, 100],
        [40, 0],
      ]),
    }),
    layer('Shield', [shield], {
      position: anim([
        [0, [256, 256]],
        [62, [256, 256]],
        [78, [176, 256]],
      ]),
      scale: anim([
        [0, [0, 0]],
        [34, [0, 0], OVERSHOOT],
        [48, [100, 100]],
        [62, [100, 100]],
        [78, [86, 86]],
        [104, [86, 86]],
        [114, [0, 0]],
      ]),
    }),
    layer('Receipt', [receipt], {
      position: anim([
        [0, [176, 256]],
        [76, [176, 256], EASE_OUT],
        [96, [392, 274]],
      ]),
      scale: anim([
        [0, [0, 0]],
        [76, [30, 30], EASE_OUT],
        [96, [100, 100]],
        [104, [100, 100]],
        [114, [0, 0]],
      ]),
      opacity: anim([
        [0, 0],
        [76, 0],
        [80, 100],
        [104, 100],
        [112, 0],
      ]),
    }),
  ]);
}

// ── Paying: the four accepted coins, smallest to largest ─────────────────
/** Stroke glyphs for the digits the coins need, in a 1-unit-tall box. */
const DIGITS = {
  1: () => [bezier([[-0.16, -0.28], [0.04, -0.5], [0.04, 0.5]])],
  0: () => [ellipse([0.56, 1])],
  2: () => [
    bezier([
      [-0.26, -0.22, [0, 0], [0, -0.17]],
      [0, -0.5, [-0.16, 0], [0.16, 0]],
      [0.27, -0.23, [0, -0.16], [0, 0.14]],
      [-0.27, 0.5, [0.12, -0.14], [0, 0]],
      [0.28, 0.5],
    ]),
  ],
  5: () => [
    bezier([
      [0.25, -0.5],
      [-0.2, -0.5],
      [-0.25, -0.04, [0, 0], [0.12, -0.1]],
      [0.27, 0.17, [0, -0.22], [0, 0.2]],
      [-0.01, 0.5, [0.17, 0], [-0.14, 0]],
      [-0.28, 0.36, [0.07, 0.09], [0, 0]],
    ]),
  ],
};

const scaleGeometry = (shape, h, dx) => {
  if (shape.ty === 'el') {
    return ellipse([shape.s.k[0] * h, shape.s.k[1] * h], [dx * h, 0]);
  }
  const k = shape.ks.k;
  return {
    ...shape,
    ks: {
      a: 0,
      k: {
        c: k.c,
        v: k.v.map(([x, y]) => [(x + dx) * h, y * h]),
        i: k.i.map(([x, y]) => [x * h, y * h]),
        o: k.o.map(([x, y]) => [x * h, y * h]),
      },
    },
  };
};

function numeral(value, height) {
  const chars = String(value).split('');
  const spacing = 0.68;
  return chars.map((char, index) => {
    const dx = (index - (chars.length - 1) / 2) * spacing;
    return part(
      DIGITS[char]().map((shape) => scaleGeometry(shape, height, dx)),
      [stroke(COLOR.deepSpace, Math.max(4, height * 0.15))],
    );
  });
}

function coins() {
  // Real diameters (mm) of the ₱1, ₱5, ₱10, ₱20 coins keep their size order.
  const COINS = [
    [1, 23],
    [5, 25],
    [10, 27],
    [20, 30],
  ];
  const PX_PER_MM = 3.6;
  const GAP = 22;
  const sizes = COINS.map(([, mm]) => mm * PX_PER_MM);
  const total = sizes.reduce((a, b) => a + b, 0) + GAP * (COINS.length - 1);
  let x = 256 - total / 2;
  const ROW_Y = 330;

  const coinLayers = COINS.map(([value], index) => {
    const d = sizes[index];
    const cx = x + d / 2;
    x += d + GAP;
    const start = 6 + index * 8;
    const lift = 52 + index * 12;
    const coin = group([
      part([ellipse([d + 18, d + 18])], [stroke(COLOR.mint, 5)], {
        opacity: anim([
          [0, 0],
          [lift, 0],
          [lift + 6, 100],
          [lift + 18, 100],
          [lift + 24, 0],
        ]),
      }),
      part([ellipse([d, d])], [fill(COLOR.silver), stroke(COLOR.silverEdge, 4)]),
      part([ellipse([d - 16, d - 16])], [stroke(COLOR.silverInner, 2)]),
      ...numeral(value, d * 0.42),
    ]);
    return layer(`Coin ${value}`, [coin], {
      position: anim([
        [0, [cx, ROW_Y + 40]],
        [start, [cx, ROW_Y + 40], EASE_OUT],
        [start + 14, [cx, ROW_Y]],
        [lift, [cx, ROW_Y], EASE_OUT],
        [lift + 8, [cx, ROW_Y - 18]],
        [lift + 20, [cx, ROW_Y - 18]],
        [lift + 28, [cx, ROW_Y]],
      ]),
      scale: popScale(start),
    });
  });

  const slot = group([
    part([rect([200, 76], [0, 0], 22)], [fill(COLOR.night), stroke(COLOR.lavender, 6)]),
    part([rect([96, 12], [0, 0], 6)], [fill(COLOR.deepSpace), stroke(COLOR.mint, 3)]),
  ]);

  const arrow = group([
    part(
      [bezier([[0, 26], [0, -18]]), bezier([[-16, -2], [0, -20], [16, -2]])],
      [stroke(COLOR.mint, 7)],
    ),
  ]);

  return animation('PrintBit — Accepted coins', FRAMES, [
    layer('Slot', [slot], { position: [256, 132], opacity: fadeLoop(0, 110) }),
    layer('Arrow', [arrow], {
      position: anim([
        [0, [256, 214]],
        [40, [256, 214]],
        [56, [256, 198]],
        [72, [256, 214]],
        [88, [256, 198]],
        [104, [256, 214]],
      ]),
      opacity: fadeLoop(36),
    }),
    ...coinLayers,
  ]);
}

const OUTPUTS = {
  welcome,
  'supported-files': supportedFiles,
  'privacy-receipt': privacyReceipt,
  paying: coins,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, build] of Object.entries(OUTPUTS)) {
  const target = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(target, `${JSON.stringify(build())}\n`, 'utf8');
  console.log(`write  idle-src/${name}.json`);
}
