/**
 * Small helpers for authoring flat vector Lottie animations in code.
 * Used by scripts/generate-idle-lottie-assets.js.
 */

const FRAME_RATE = 30;
const SIZE = 512;

/** PrintBit palette as Lottie RGBA (0..1). */
const hex = (value, alpha = 1) => {
  const n = Number.parseInt(value.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
};

const COLOR = {
  deepSpace: hex('#0e0d1f'),
  night: hex('#1b1a35'),
  indigo: hex('#696fc7'),
  lavender: hex('#a7aae1'),
  pink: hex('#f2aebb'),
  peach: hex('#f5d3c4'),
  mint: hex('#8de5bc'),
  white: hex('#ffffff'),
  paperLine: hex('#c9c9dc'),
  silver: hex('#d9dbea'),
  silverEdge: hex('#8e90ad'),
  silverInner: hex('#b4b6cf'),
};

const EASE_OUT = { i: { x: [0.2], y: [1] }, o: { x: [0.4], y: [0] } };
const EASE_IN_OUT = { i: { x: [0.6], y: [1] }, o: { x: [0.4], y: [0] } };
const OVERSHOOT = { i: { x: [0.3], y: [1.35] }, o: { x: [0.5], y: [0] } };

const asArray = (value) => (Array.isArray(value) ? value : [value]);

const still = (value) => ({ a: 0, k: value });

/**
 * Animated property from [frame, value, ease?] tuples. `ease` shapes the
 * segment that starts at that keyframe.
 */
const anim = (keys) => ({
  a: 1,
  k: keys.map(([t, value, ease = EASE_IN_OUT], index) => {
    const frame = { t, s: asArray(value) };
    if (index < keys.length - 1) {
      frame.i = ease.i;
      frame.o = ease.o;
    }
    return frame;
  }),
});

const prop = (value) =>
  value && typeof value === 'object' && 'a' in value ? value : still(value);

// ── Shapes ────────────────────────────────────────────────────────────────
const rect = (size, position = [0, 0], radius = 0) => ({
  ty: 'rc',
  d: 1,
  p: prop(position),
  s: prop(size),
  r: prop(radius),
});

const ellipse = (size, position = [0, 0]) => ({
  ty: 'el',
  d: 1,
  p: prop(position),
  s: prop(size),
});

/**
 * Bezier path. Each point is [x, y] or [x, y, inTangent, outTangent] with
 * tangents relative to the vertex.
 */
const path = (points, closed = false) => ({
  ty: 'sh',
  ks: still({
    c: closed,
    v: points.map((p) => [p[0], p[1]]),
    i: points.map((p) => p[2] ?? [0, 0]),
    o: points.map((p) => p[3] ?? [0, 0]),
  }),
});

const fill = (color, opacity = 100) => ({
  ty: 'fl',
  c: prop(color),
  o: prop(opacity),
  r: 1,
});

const stroke = (color, width, opacity = 100) => ({
  ty: 'st',
  c: prop(color),
  o: prop(opacity),
  w: prop(width),
  lc: 2,
  lj: 2,
  ml: 4,
});

const trim = (end, start = 0) => ({
  ty: 'tm',
  s: prop(start),
  e: prop(end),
  o: still(0),
  m: 1,
});

const groupTransform = ({
  position = [0, 0],
  anchor = [0, 0],
  scale = [100, 100],
  rotation = 0,
  opacity = 100,
} = {}) => ({
  ty: 'tr',
  p: prop(position),
  a: prop(anchor),
  s: prop(scale),
  r: prop(rotation),
  o: prop(opacity),
  sk: still(0),
  sa: still(0),
});

/**
 * One drawable: geometry (plus modifiers such as trim) painted by `paints`.
 * Paints are listed back to front, e.g. [fill, stroke] puts the stroke on top.
 */
const part = (geometry, paints, transform) => ({
  ty: 'gr',
  it: [...geometry, ...[...paints].reverse(), groupTransform(transform)],
});

/** Parts listed back to front: later parts paint over earlier ones. */
const group = (parts, transform) => ({
  ty: 'gr',
  it: [...[...parts].reverse(), groupTransform(transform)],
});

// ── Layers ────────────────────────────────────────────────────────────────
let nextIndex = 1;

/**
 * Shape layer; `shapes` are parts or groups listed back to front.
 * animation() takes layers back to front too.
 */
const layer = (
  name,
  shapes,
  { position = [SIZE / 2, SIZE / 2], scale = [100, 100], rotation = 0, opacity = 100 } = {},
  { inPoint = 0, outPoint } = {},
) => ({
  ddd: 0,
  ind: nextIndex++,
  ty: 4,
  nm: name,
  sr: 1,
  ks: {
    o: prop(opacity),
    r: prop(rotation),
    p: prop(position),
    a: still([0, 0, 0]),
    s: prop(scale),
  },
  ao: 0,
  shapes: [...shapes].reverse(),
  ip: inPoint,
  op: outPoint,
  st: 0,
  bm: 0,
});

const animation = (name, frames, layers) => ({
  v: '5.12.2',
  fr: FRAME_RATE,
  ip: 0,
  op: frames,
  w: SIZE,
  h: SIZE,
  nm: name,
  ddd: 0,
  assets: [],
  layers: [...layers].reverse().map((l) => ({ ...l, op: l.op ?? frames })),
});

module.exports = {
  COLOR,
  EASE_IN_OUT,
  EASE_OUT,
  FRAME_RATE,
  OVERSHOOT,
  SIZE,
  anim,
  animation,
  ellipse,
  fill,
  group,
  hex,
  layer,
  part,
  path,
  rect,
  still,
  stroke,
  trim,
};
