/**
 * The pizza-slice illustration the ASCII renderer samples.
 *
 * It is a flat, cartoon-style vector drawing (crust, sauce rim, cheese with
 * drips, pepperoni, basil) described with canvas paths in a local coordinate
 * system where the slice's tip points straight up. The renderer rotates it
 * 45° clockwise, rasterises it once per resize at character-grid resolution,
 * and colours each glyph from it.
 *
 * Every fill uses one of the {@link MATERIALS}; the renderer maps each
 * sampled colour back to its nearest material, whose shadow → mid → highlight
 * ramp drives the animated brightness.
 */

export interface Material {
  name: string;
  /** Flat colour used in the illustration. */
  base: string;
  /** Darkest glyph colour (wave troughs). */
  shadow: string;
  /** Glyph colour at the crest of a light band (the very top level adds a pale glint on top). */
  highlight: string;
  /** Pushes glyph choice denser (+) or sparser (−): darker / more saturated areas get denser glyphs. */
  density: number;
  /** Minimum brightness (0–1) so small, important shapes (pepperoni, basil) never sink into a dark band. */
  floor: number;
}

export const MATERIALS: readonly Material[] = [
  { name: 'cheese', base: '#ffc53d', shadow: '#9c5c0a', highlight: '#ffe46b', density: 0, floor: 0 },
  { name: 'cheese-light', base: '#ffe27e', shadow: '#a86f16', highlight: '#fff09a', density: -1, floor: 0 },
  { name: 'cheese-shade', base: '#f09a1e', shadow: '#7a3d05', highlight: '#ffc34a', density: 1, floor: 0.2 },
  { name: 'sauce', base: '#d8391f', shadow: '#5e0f08', highlight: '#ff6a3d', density: 2, floor: 0.5 },
  { name: 'pepperoni', base: '#c8281f', shadow: '#4f0a07', highlight: '#ff5a3c', density: 2, floor: 0.56 },
  { name: 'pepperoni-dark', base: '#8a1712', shadow: '#330506', highlight: '#d8402c', density: 3, floor: 0.42 },
  { name: 'crust', base: '#d9974d', shadow: '#6a3812', highlight: '#f5c07a', density: 1, floor: 0.3 },
  { name: 'crust-dark', base: '#9e5a24', shadow: '#3e1f09', highlight: '#d88e4c', density: 2, floor: 0.3 },
  { name: 'crust-light', base: '#f3c98b', shadow: '#8a5a2a', highlight: '#ffe2b3', density: 0, floor: 0.3 },
  { name: 'basil', base: '#3f9f50', shadow: '#0e3a18', highlight: '#7fe08f', density: 1, floor: 0.5 },
  { name: 'basil-dark', base: '#236e33', shadow: '#0a2610', highlight: '#4fbf64', density: 2, floor: 0.4 },
];

const M = Object.fromEntries(MATERIALS.map((m) => [m.name, m.base])) as Record<string, string>;

// ─── Geometry (local units; tip at the top) ─────────────────────────────────

const APEX = { x: 0, y: -62 };
/** Distance from the tip to the middle of the crust. */
const R = 118;
/** Half the opening angle of the slice. */
const HALF = (20 * Math.PI) / 180;

/** Point at distance `r` from the tip, `phi` radians off straight-down (+ = to the right). */
function polar(r: number, phi: number): [number, number] {
  return [APEX.x + r * Math.sin(phi), APEX.y + r * Math.cos(phi)];
}

/**
 * Points on the outer silhouette, used to compute the rotated bounding box
 * (so the slice can be centred and sized exactly).
 */
export function outlinePoints(): Array<[number, number]> {
  const pts: Array<[number, number]> = [[APEX.x, APEX.y]];
  const extra = (5 * Math.PI) / 180;
  for (let a = -HALF - extra; a <= HALF + extra + 1e-9; a += Math.PI / 360) pts.push(polar(R + 10, a));
  return pts;
}

function sector(ctx: CanvasRenderingContext2D, r: number, from: number, to: number): void {
  ctx.beginPath();
  ctx.moveTo(APEX.x, APEX.y);
  // Canvas angles are measured from +x towards +y (down); "straight down" is π/2.
  ctx.arc(APEX.x, APEX.y, r, Math.PI / 2 - to, Math.PI / 2 - from);
  ctx.closePath();
}

function crustArc(ctx: CanvasRenderingContext2D, r: number, width: number, color: string, overshoot = 0): void {
  ctx.beginPath();
  ctx.arc(APEX.x, APEX.y, r, Math.PI / 2 - HALF - overshoot, Math.PI / 2 + HALF + overshoot);
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.stroke();
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function leaf(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, wid: number, rot: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(-len / 2, 0);
  ctx.quadraticCurveTo(0, -wid, len / 2, 0);
  ctx.quadraticCurveTo(0, wid, -len / 2, 0);
  ctx.fillStyle = M.basil!;
  ctx.fill();
  // Midrib and one darker half, for a bit of cartoon form.
  ctx.beginPath();
  ctx.moveTo(-len / 2, 0);
  ctx.quadraticCurveTo(0, wid * 0.9, len / 2, 0);
  ctx.quadraticCurveTo(0, wid * 0.25, -len / 2, 0);
  ctx.fillStyle = M['basil-dark']!;
  ctx.fill();
  ctx.restore();
}

/** Draw the slice (tip up) in local units. The caller sets up the transform. */
export function drawPizzaSlice(ctx: CanvasRenderingContext2D): void {
  ctx.save();

  // Crust: dark underside, main bake, and a puffy highlight on top.
  crustArc(ctx, R + 3, 19, M['crust-dark']!, 0.02);
  crustArc(ctx, R, 14, M.crust!);
  crustArc(ctx, R - 3.5, 4.5, M['crust-light']!, -0.03);

  // Sauce rim peeking out between cheese and crust.
  sector(ctx, R - 5, -HALF, HALF);
  ctx.fillStyle = M.sauce!;
  ctx.fill();

  // Cheese, with a wobbly edge that drips over the sauce in a few places.
  ctx.beginPath();
  ctx.moveTo(APEX.x, APEX.y);
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const phi = HALF - t * 2 * HALF; // right → left
    const drip = Math.max(0, Math.sin(t * Math.PI * 5 + 0.6)) ** 3 * 7;
    const r = R - 10 + drip + Math.sin(t * 23) * 0.8;
    const [x, y] = polar(r, phi * 0.985);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = M.cheese!;
  ctx.fill();

  // Cartoon shading: a darker band down the left edge, a bright streak on the right.
  ctx.save();
  sector(ctx, R - 11, -HALF, HALF);
  ctx.clip();
  sector(ctx, R, -HALF, -HALF + 0.1);
  ctx.fillStyle = M['cheese-shade']!;
  ctx.fill();
  ctx.beginPath();
  const [sx0, sy0] = polar(18, HALF * 0.55);
  const [sx1, sy1] = polar(78, HALF * 0.62);
  ctx.moveTo(sx0, sy0);
  ctx.lineTo(sx1, sy1);
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = M['cheese-light']!;
  ctx.stroke();
  // Melty bubbles.
  for (const [r, phi, size] of [
    [44, -0.18, 3.2],
    [92, 0.05, 3.6],
    [66, -0.02, 2.6],
    [100, -0.24, 2.8],
  ] as const) {
    const [x, y] = polar(r, phi);
    disc(ctx, x, y, size, M['cheese-light']!);
  }
  ctx.restore();

  // Pepperoni: dark rim, lighter face, a couple of charred spots.
  for (const [r, phi, size] of [
    [52, -0.1, 10],
    [80, 0.14, 11],
    [96, -0.19, 10.5],
    [26, 0.05, 6.5],
  ] as const) {
    const [x, y] = polar(r, phi);
    disc(ctx, x, y, size, M['pepperoni-dark']!);
    disc(ctx, x - 0.8, y - 0.8, size - 2.4, M.pepperoni!);
    disc(ctx, x + size * 0.3, y + size * 0.15, size * 0.18, M['pepperoni-dark']!);
    disc(ctx, x - size * 0.35, y + size * 0.3, size * 0.14, M['pepperoni-dark']!);
  }

  // Basil.
  {
    const [x1, y1] = polar(40, 0.12);
    leaf(ctx, x1, y1, 15, 6.5, -0.7);
    const [x2, y2] = polar(99, 0.03);
    leaf(ctx, x2, y2, 17, 7, 0.35);
  }

  ctx.restore();
}

// ─── Whole pizza (the 404 page) ─────────────────────────────────────────────

/** Outer radius of the whole pizza, in local units centred on (0, 0). */
export const WHOLE_RADIUS = 106;

/**
 * A whole pizza, centred on (0, 0) and seen from above: crust, sauce rim,
 * cheese with drips, cut lines, pepperoni, basil. Nothing in it depends on
 * the direction of the light, so it can be spun freely.
 */
export function drawWholePizza(ctx: CanvasRenderingContext2D): void {
  ctx.save();

  // Crust: dark underside, main bake, a puffy highlight ring.
  disc(ctx, 0, 0, WHOLE_RADIUS, M['crust-dark']!);
  disc(ctx, 0, 0, WHOLE_RADIUS - 4, M.crust!);
  ctx.beginPath();
  ctx.arc(0, 0, WHOLE_RADIUS - 8.5, 0, Math.PI * 2);
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = M['crust-light']!;
  ctx.stroke();

  // Sauce rim, then cheese whose wobbly edge drips over it here and there.
  disc(ctx, 0, 0, WHOLE_RADIUS - 13, M.sauce!);
  ctx.beginPath();
  const steps = 180;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const drip = Math.max(0, Math.sin(a * 9 + 0.4)) ** 3 * 6;
    const r = WHOLE_RADIUS - 21 + drip + Math.sin(a * 31) * 0.8;
    ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  ctx.closePath();
  ctx.fillStyle = M.cheese!;
  ctx.fill();

  // Cut into eight slices.
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = M['cheese-shade']!;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 + 0.2;
    ctx.beginPath();
    ctx.moveTo(4 * Math.cos(a), 4 * Math.sin(a));
    ctx.lineTo((WHOLE_RADIUS - 20) * Math.cos(a), (WHOLE_RADIUS - 20) * Math.sin(a));
    ctx.stroke();
  }

  // Melty bubbles.
  for (const [r, a, size] of [
    [22, 2.2, 4],
    [48, 1.1, 3.6],
    [72, 3.0, 4.2],
    [44, 3.6, 3.4],
    [78, 5.5, 3.8],
  ] as const) {
    disc(ctx, r * Math.cos(a), r * Math.sin(a), size, M['cheese-light']!);
  }

  // Pepperoni: dark rim, lighter face, a couple of charred spots.
  // Bigger than the slice's: the whole pizza gets fewer glyphs per unit, and toppings must still read as shapes.
  for (const [r, a, size] of [
    [63, 0.6, 14.5],
    [61, 2.15, 14],
    [64, 3.7, 15],
    [62, 5.2, 14],
    [30, 1.4, 13],
    [32, 4.3, 13.5],
    [8, 2.9, 10],
  ] as const) {
    const x = r * Math.cos(a);
    const y = r * Math.sin(a);
    disc(ctx, x, y, size, M['pepperoni-dark']!);
    disc(ctx, x - 0.8, y - 0.8, size - 2.4, M.pepperoni!);
    disc(ctx, x + size * 0.3, y + size * 0.15, size * 0.18, M['pepperoni-dark']!);
    disc(ctx, x - size * 0.35, y + size * 0.3, size * 0.14, M['pepperoni-dark']!);
  }

  // Basil.
  for (const [r, a, len, rot] of [
    [50, 5.95, 22, 0.9],
    [52, 2.95, 21, -0.4],
    [74, 1.4, 19, 0.2],
    [26, 0.1, 18, 1.4],
  ] as const) {
    leaf(ctx, r * Math.cos(a), r * Math.sin(a), len, len * 0.42, rot);
  }

  ctx.restore();
}
