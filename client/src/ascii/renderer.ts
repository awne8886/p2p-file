import { dist2, hash2, hexToRgb, mix, mulberry32, rgbCss, type RGB } from './color';
import { drawPizzaSlice, drawWholePizza, MATERIALS, outlinePoints, WHOLE_RADIUS } from './pizzaArt';

/**
 * Animated colour-ASCII pizza.
 *
 * 1. Layout: the slice (tip up, then tilted 45° clockwise) is sized to ~52% of
 *    the smaller viewport side and centred. A character grid covers it.
 * 2. Sampling (on resize only): the vector illustration is rasterised at a few
 *    pixels per character cell; each cell gets a coverage value and the
 *    material (cheese, pepperoni, crust…) its average colour is closest to.
 * 3. Atlas (on resize only): every glyph × material × brightness level is
 *    pre-drawn once into an offscreen canvas (bright levels with a soft glow),
 *    so a frame is just a few thousand `drawImage` blits — no text shaping.
 * 4. Per frame: like the reference, each row of glyphs is displaced by a slow
 *    travelling wave so the grid ripples like fabric, and diagonal light bands
 *    sweep across it. Brightness picks the colour level and the glyph from a
 *    density ramp (`. : + * = # % @`); darker, more saturated materials
 *    (pepperoni, sauce, crust) are biased towards denser glyphs. A sparse
 *    random flicker adds shimmer.
 *
 * Outside the slice the canvas is pure black apart from ≤ 15 dim "stars".
 *
 * The `whole` scene (the 404 page) draws an entire pizza instead, turning
 * slowly clockwise. The glyph grid itself never rotates, so glyphs stay
 * upright: the illustration is rasterised once into a material map, and each
 * frame every cell looks up which part of the turning pizza is under it.
 */

/** `slice`: the tilted slice (every normal page). `whole`: a whole pizza that slowly spins (the 404 page). */
export type PizzaScene = 'slice' | 'whole';

const RAMP = ['.', ':', '+', '*', '=', '#', '%', '@'] as const;
const LEVELS = 12;
/** Levels at or above this get a glow baked into their sprite. */
const GLOW_FROM = 7;
const TILT = Math.PI / 4; // 45° clockwise (canvas y points down)
const MAX_STARS = 15;
const STAR_GLYPHS = ['.', '*', '+', "'", ':'] as const;
const FONT_STACK =
  'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace';
/** Samples per cell when rasterising the illustration. */
const SUB_X = 4;
const SUB_Y = 6;
const TAU = Math.PI * 2;
/** The whole pizza turns clockwise once every this many seconds. */
const SPIN_PERIOD_S = 90;
/** Texels across the whole pizza's material map. */
const MAP_SIZE = 320;
/** Material-map texel outside the pizza. */
const EMPTY = 255;
const CRUST_DARK = MATERIALS.findIndex((m) => m.name === 'crust-dark');

/**
 * Side length (CSS px) of the square the tilted slice is fitted into: 52% of
 * the smaller viewport side (58% on small screens). Exported so the UI can
 * keep its panels clear of the slice.
 */
export function sliceExtent(width: number, height: number): number {
  const minDim = Math.min(width, height);
  return minDim * (minDim < 560 ? 0.58 : 0.52);
}

interface Atlas {
  canvas: HTMLCanvasElement;
  /** Sprite size in device pixels. */
  w: number;
  h: number;
  /** First brightness level stored in this atlas. */
  from: number;
}

interface Star {
  x: number;
  y: number;
  glyph: string;
  base: number;
  amp: number;
  period: number;
  phase: number;
}

export interface RendererOptions {
  reducedMotion?: boolean;
  scene?: PizzaScene;
  /** Seed for star placement; defaults to a fresh random seed per page load. */
  seed?: number;
}

export class AsciiPizzaRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly seed: number;
  private readonly scene: PizzaScene;
  private reducedMotion: boolean;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private fontPx = 10;
  private cellW = 8;
  private cellH = 13;
  private gridX = 0;
  private gridY = 0;
  private cols = 0;
  private rows = 0;
  private coverageGrid = new Float32Array(0);

  // Visible cells, struct-of-arrays for a tight per-frame loop.
  private count = 0;
  private cellX = new Float32Array(0);
  private cellY = new Float32Array(0);
  private cellMat = new Uint8Array(0);
  private cellCov = new Float32Array(0);
  private cellDensity = new Int8Array(0);
  private cellFloor = new Float32Array(0);
  private cellRand = new Float32Array(0);

  // Whole pizza: each cell's position in the pizza's own (unturned) units, the
  // illustration's material per texel, and how far it has turned (radians).
  private cellLX = new Float32Array(0);
  private cellLY = new Float32Array(0);
  private matMap = new Uint8Array(0);
  private spin = 0;
  private appliedSpin = NaN;

  /** Glyph sprites: tight cells for ordinary levels, padded cells (room for the glow) for bright ones. */
  private atlases: [Atlas, Atlas] | null = null;

  private stars: Star[] = [];

  private running = false;
  private rafId = 0;
  private lastFrame = 0;
  private animTime = 0;
  private energy = 0;
  private targetEnergy = 0;
  private minFrameMs = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: RendererOptions = {},
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
    this.reducedMotion = opts.reducedMotion ?? false;
    this.scene = opts.scene ?? 'slice';
    this.seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  }

  /** CSS-pixel size of the canvas and the device pixel ratio to render at. */
  resize(width: number, height: number, dpr: number): void {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.layoutAndSample();
    this.buildAtlas();
    this.placeStars();
    this.renderOnce();
  }

  start(): void {
    if (this.running || this.reducedMotion) return;
    this.running = true;
    this.lastFrame = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      this.stop();
      this.renderOnce();
    } else {
      this.start();
    }
  }

  /** 0 = calm, 1 = excited (file dragged over the page). Eased over ~½ s. */
  setEnergy(energy: number): void {
    this.targetEnergy = Math.max(0, Math.min(1, energy));
    if (this.reducedMotion) this.renderOnce();
  }

  /**
   * Cap the frame rate (0 = the display's own). While a transfer runs, every
   * millisecond of main thread spent drawing is one WebRTC can't use, and the
   * slow shimmer looks the same at 30 fps.
   */
  setMaxFps(fps: number): void {
    this.minFrameMs = fps > 0 ? 1000 / fps : 0;
  }

  dispose(): void {
    this.stop();
    this.atlases = null;
  }

  // ─── Layout & sampling ───────────────────────────────────────────────────

  private layoutAndSample(): void {
    if (this.scene === 'whole') return this.layoutWhole();
    const { width: w, height: h } = this;
    const extent = sliceExtent(w, h);

    // ~42 rows across the slice; clamp so glyphs stay legible and the grid stays affordable.
    this.cellH = Math.max(8.5, Math.min(15, extent / 42));
    this.fontPx = this.cellH / 1.2;
    this.cellW = this.fontPx * 0.72;

    // Bounding box of the tilted slice in local units → scale and centre.
    const cos = Math.cos(TILT);
    const sin = Math.sin(TILT);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outlinePoints()) {
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }
    const scale = extent / Math.max(maxX - minX, maxY - minY);
    const bcx = (minX + maxX) / 2;
    const bcy = (minY + maxY) / 2;

    const margin = 2;
    this.cols = Math.ceil(((maxX - minX) * scale) / this.cellW) + margin * 2;
    this.rows = Math.ceil(((maxY - minY) * scale) / this.cellH) + margin * 2;
    this.gridX = w / 2 - (this.cols * this.cellW) / 2;
    this.gridY = h / 2 - (this.rows * this.cellH) / 2;

    // Rasterise the illustration at SUB_X × SUB_Y samples per cell.
    const off = document.createElement('canvas');
    off.width = this.cols * SUB_X;
    off.height = this.rows * SUB_Y;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return;
    const kx = SUB_X / this.cellW;
    const ky = SUB_Y / this.cellH;
    octx.setTransform(kx, 0, 0, ky, -this.gridX * kx, -this.gridY * ky);
    octx.translate(w / 2, h / 2);
    octx.scale(scale, scale);
    octx.translate(-bcx, -bcy);
    octx.rotate(TILT);
    drawPizzaSlice(octx);
    const px = octx.getImageData(0, 0, off.width, off.height).data;

    const bases: RGB[] = MATERIALS.map((m) => hexToRgb(m.base));
    const total = this.cols * this.rows;
    this.coverageGrid = new Float32Array(total);
    const xs: number[] = [];
    const ys: number[] = [];
    const mats: number[] = [];
    const covs: number[] = [];
    const dens: number[] = [];
    const floors: number[] = [];
    const rand = mulberry32(this.seed ^ 0x5eed);

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        let a = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let sy = 0; sy < SUB_Y; sy++) {
          let i = ((row * SUB_Y + sy) * off.width + col * SUB_X) * 4;
          for (let sx = 0; sx < SUB_X; sx++, i += 4) {
            const alpha = px[i + 3]!;
            a += alpha;
            r += px[i]! * alpha;
            g += px[i + 1]! * alpha;
            b += px[i + 2]! * alpha;
          }
        }
        const coverage = a / (SUB_X * SUB_Y * 255);
        this.coverageGrid[row * this.cols + col] = coverage;
        if (coverage < 0.12) continue;
        const avg: RGB = [r / a, g / a, b / a];
        let best = 0;
        let bestD = Infinity;
        bases.forEach((base, m) => {
          const d = dist2(avg, base);
          if (d < bestD) {
            bestD = d;
            best = m;
          }
        });
        xs.push(this.gridX + (col + 0.5) * this.cellW);
        ys.push(this.gridY + (row + 0.5) * this.cellH);
        mats.push(best);
        covs.push(Math.min(1, coverage));
        dens.push(MATERIALS[best]!.density);
        floors.push(MATERIALS[best]!.floor);
      }
    }

    this.count = xs.length;
    this.cellX = Float32Array.from(xs);
    this.cellY = Float32Array.from(ys);
    this.cellMat = Uint8Array.from(mats);
    this.cellCov = Float32Array.from(covs);
    this.cellDensity = Int8Array.from(dens);
    this.cellFloor = Float32Array.from(floors);
    this.cellRand = Float32Array.from(xs, () => rand());
  }

  /** The whole pizza: same size and glyph grid as the slice, but a circle, and sampled through a material map. */
  private layoutWhole(): void {
    const { width: w, height: h } = this;
    const extent = sliceExtent(w, h);
    this.cellH = Math.max(8.5, Math.min(15, extent / 42));
    this.fontPx = this.cellH / 1.2;
    this.cellW = this.fontPx * 0.72;

    const scale = extent / (2 * WHOLE_RADIUS);
    const margin = 2;
    this.cols = Math.ceil(extent / this.cellW) + margin * 2;
    this.rows = Math.ceil(extent / this.cellH) + margin * 2;
    this.gridX = w / 2 - (this.cols * this.cellW) / 2;
    this.gridY = h / 2 - (this.rows * this.cellH) / 2;

    // Rasterise the illustration once and store each texel's nearest material.
    const off = document.createElement('canvas');
    off.width = MAP_SIZE;
    off.height = MAP_SIZE;
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return;
    const k = MAP_SIZE / (2 * WHOLE_RADIUS);
    octx.setTransform(k, 0, 0, k, MAP_SIZE / 2, MAP_SIZE / 2);
    drawWholePizza(octx);
    const px = octx.getImageData(0, 0, MAP_SIZE, MAP_SIZE).data;
    const bases: RGB[] = MATERIALS.map((m) => hexToRgb(m.base));
    const map = new Uint8Array(MAP_SIZE * MAP_SIZE);
    for (let i = 0; i < map.length; i++) {
      if (px[i * 4 + 3]! < 128) {
        map[i] = EMPTY;
        continue;
      }
      const rgb: RGB = [px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!];
      let best = 0;
      let bestD = Infinity;
      bases.forEach((base, m) => {
        const d = dist2(rgb, base);
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      });
      map[i] = best;
    }
    this.matMap = map;

    // Cells: everything inside the circle, with coverage fading over the last cell at the rim.
    const cellLocal = this.cellH / scale;
    this.coverageGrid = new Float32Array(this.cols * this.rows);
    const xs: number[] = [];
    const ys: number[] = [];
    const lxs: number[] = [];
    const lys: number[] = [];
    const covs: number[] = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const x = this.gridX + (col + 0.5) * this.cellW;
        const y = this.gridY + (row + 0.5) * this.cellH;
        const lx = (x - w / 2) / scale;
        const ly = (y - h / 2) / scale;
        const coverage = Math.max(0, Math.min(1, (WHOLE_RADIUS - Math.hypot(lx, ly)) / cellLocal + 0.5));
        this.coverageGrid[row * this.cols + col] = coverage;
        if (coverage < 0.12) continue;
        xs.push(x);
        ys.push(y);
        lxs.push(lx);
        lys.push(ly);
        covs.push(coverage);
      }
    }

    const rand = mulberry32(this.seed ^ 0x5eed);
    this.count = xs.length;
    this.cellX = Float32Array.from(xs);
    this.cellY = Float32Array.from(ys);
    this.cellLX = Float32Array.from(lxs);
    this.cellLY = Float32Array.from(lys);
    this.cellCov = Float32Array.from(covs);
    this.cellMat = new Uint8Array(this.count);
    this.cellDensity = new Int8Array(this.count);
    this.cellFloor = new Float32Array(this.count);
    this.cellRand = Float32Array.from(xs, () => rand());
    this.appliedSpin = NaN;
  }

  /** Whole pizza: find the material under every cell once the pizza has turned `angle` radians clockwise. */
  private applySpin(angle: number): void {
    if (angle === this.appliedSpin) return;
    this.appliedSpin = angle;
    // A point p of the pizza shows at R(angle)·p (canvas y points down, so +angle is clockwise);
    // the cell at q therefore shows p = R(−angle)·q.
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const k = MAP_SIZE / (2 * WHOLE_RADIUS);
    const half = MAP_SIZE / 2;
    for (let i = 0; i < this.count; i++) {
      const lx = this.cellLX[i]!;
      const ly = this.cellLY[i]!;
      const col = Math.floor((lx * c + ly * s) * k + half);
      const row = Math.floor((-lx * s + ly * c) * k + half);
      let m = col >= 0 && col < MAP_SIZE && row >= 0 && row < MAP_SIZE ? this.matMap[row * MAP_SIZE + col]! : EMPTY;
      if (m === EMPTY) m = CRUST_DARK; // anti-aliased rim
      const mat = MATERIALS[m]!;
      this.cellMat[i] = m;
      this.cellDensity[i] = mat.density;
      this.cellFloor[i] = mat.floor;
    }
  }

  // ─── Glyph atlas ─────────────────────────────────────────────────────────

  private buildAtlas(): void {
    const dpr = this.dpr;
    const tightPad = 1;
    const glowPad = Math.ceil(this.fontPx * dpr * 0.45);
    const tight = this.makeAtlas(tightPad, 0, GLOW_FROM);
    const glow = this.makeAtlas(glowPad, GLOW_FROM, LEVELS);
    this.atlases = tight && glow ? [tight, glow] : null;
  }

  /**
   * Pre-render every glyph × material for brightness levels [from, to).
   * Blitting only the tight cell for the common, un-glowing levels keeps the
   * per-frame fill cost several times lower than padding every sprite.
   */
  private makeAtlas(pad: number, from: number, to: number): Atlas | null {
    const dpr = this.dpr;
    const w = Math.ceil(this.cellW * dpr) + pad * 2;
    const h = Math.ceil(this.cellH * dpr) + pad * 2;
    const canvas = document.createElement('canvas');
    canvas.width = w * RAMP.length * MATERIALS.length;
    canvas.height = h * (to - from);
    const actx = canvas.getContext('2d');
    if (!actx) return null;
    actx.font = `700 ${this.fontPx * dpr}px ${FONT_STACK}`;
    actx.textAlign = 'center';
    actx.textBaseline = 'middle';

    const white = hexToRgb('#fffaf0');
    MATERIALS.forEach((mat, m) => {
      const shadow = hexToRgb(mat.shadow);
      const base = hexToRgb(mat.base);
      const highlight = hexToRgb(mat.highlight);
      const glint = mix(highlight, white, 0.3);
      for (let level = from; level < to; level++) {
        // shadow → base → highlight, and a pale glint on the top level only (the
        // reference's near-white sparkles on the crest of each band).
        const t = level / (LEVELS - 1);
        const rgb = t < 0.5 ? mix(shadow, base, t / 0.5) : t < 0.92 ? mix(base, highlight, (t - 0.5) / 0.42) : glint;
        const glow = level >= GLOW_FROM ? (level - GLOW_FROM + 1) / (LEVELS - GLOW_FROM) : 0;
        actx.shadowColor = glow > 0 ? rgbCss(rgb, 0.55) : 'transparent';
        actx.shadowBlur = glow * this.fontPx * dpr * 0.45;
        actx.fillStyle = rgbCss(rgb);
        RAMP.forEach((glyph, g) => {
          actx.fillText(glyph, (m * RAMP.length + g) * w + w / 2, (level - from) * h + h / 2);
        });
      }
    });
    return { canvas, w, h, from };
  }

  // ─── Stars ───────────────────────────────────────────────────────────────

  private placeStars(): void {
    const rand = mulberry32(this.seed);
    const { width: w, height: h } = this;
    const target = 9 + Math.floor(rand() * (MAX_STARS - 9 + 1)); // 9…15, never more than 15
    const minDist = Math.max(90, 0.24 * Math.sqrt(w * h));
    const edge = 20;
    const stars: Star[] = [];
    for (let attempt = 0; attempt < 800 && stars.length < target; attempt++) {
      const x = edge + rand() * (w - edge * 2);
      const y = edge + rand() * (h - edge * 2);
      if (this.nearSlice(x, y, 3)) continue;
      if (stars.some((s) => (s.x - x) ** 2 + (s.y - y) ** 2 < minDist * minDist)) continue;
      stars.push({
        x,
        y,
        glyph: STAR_GLYPHS[Math.floor(rand() * STAR_GLYPHS.length)]!,
        base: 0.24 + rand() * 0.04,
        amp: 0.04 + rand() * 0.05,
        period: 3 + rand() * 6,
        phase: rand() * TAU,
      });
    }
    this.stars = stars.slice(0, MAX_STARS);
  }

  /** Is (x, y) within `radius` cells of any part of the slice? */
  private nearSlice(x: number, y: number, radius: number): boolean {
    const col = Math.floor((x - this.gridX) / this.cellW);
    const row = Math.floor((y - this.gridY) / this.cellH);
    for (let r = row - radius; r <= row + radius; r++) {
      if (r < 0 || r >= this.rows) continue;
      for (let c = col - radius; c <= col + radius; c++) {
        if (c < 0 || c >= this.cols) continue;
        if (this.coverageGrid[r * this.cols + c]! > 0.01) return true;
      }
    }
    return false;
  }

  get starCount(): number {
    return this.stars.length;
  }

  // ─── Frame ───────────────────────────────────────────────────────────────

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);
    // Skip this display frame if a frame-rate cap is on and the last draw was too recent (1 ms of vsync jitter).
    if (this.lastFrame && now - this.lastFrame < this.minFrameMs - 1) return;
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.energy += (this.targetEnergy - this.energy) * Math.min(1, dt * 3);
    this.animTime += dt * (1 + this.energy * 1.4);
    if (this.scene === 'whole') this.spin = (this.spin + (dt * TAU) / SPIN_PERIOD_S) % TAU;
    this.draw(this.animTime, now / 1000, true);
  };

  private renderOnce(): void {
    if (this.reducedMotion) this.energy = this.targetEnergy;
    this.draw(this.reducedMotion ? 1.3 : this.animTime, 0, !this.reducedMotion);
  }

  private draw(t: number, clock: number, animated: boolean): void {
    const { ctx, dpr, atlases } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Stars.
    ctx.font = `${this.fontPx * 1.15 * dpr}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of this.stars) {
      const tw = animated ? Math.sin((clock / s.period) * TAU + s.phase) : 0;
      const alpha = Math.max(0.18, Math.min(0.35, s.base + s.amp * tw));
      ctx.fillStyle = `rgba(236, 229, 214, ${alpha.toFixed(3)})`;
      ctx.fillText(s.glyph, s.x * dpr, s.y * dpr);
    }

    if (!atlases) return;
    ctx.imageSmoothingEnabled = false;
    if (this.scene === 'whole') this.applySpin(this.spin);

    const { cellW, cellH, energy } = this;
    const lambdaX = cellW * 34;
    const lambdaY = cellH * 60;
    const bandScale = cellW * 26;
    const rowWave = cellH * 22;
    const amp = cellH * 0.55;
    const rampLen = RAMP.length;

    for (let k = 0; k < this.count; k++) {
      const x = this.cellX[k]!;
      const y = this.cellY[k]!;

      // Rippling rows (the reference's "fabric" motion).
      const w1 = Math.sin(TAU * (x / lambdaX + y / lambdaY) - 0.55 * t);
      const w2 = Math.sin(TAU * (x / (lambdaX * 0.6) - y / (lambdaY * 0.8)) + 0.8 * t + 1.7);
      const dy = amp * (0.7 * w1 + 0.3 * w2);
      const dx = cellW * 0.25 * Math.sin((TAU * y) / (cellH * 18) + 0.4 * t);

      // Diagonal light bands with wavy edges.
      const u = (x * 0.85 + y * 0.55) / bandScale;
      const warp = 0.9 * Math.sin((TAU * y) / rowWave + 0.35 * t) + 0.5 * w1;
      let b = 0.5 + 0.5 * Math.sin(TAU * u - 0.9 * t + warp);
      b = b * b * (3 - 2 * b);

      let v = 0.4 + 0.54 * b + energy * 0.1 + 0.05 * Math.sin(0.3 * t + x * 0.004 - y * 0.003);
      v = Math.max(v, this.cellFloor[k]!);
      let jitter = 0;
      if (animated) {
        const r = this.cellRand[k]!;
        const h = hash2(k, Math.floor(t * 1.7 + r * 13));
        if (h > 0.965) v += 0.28;
        else if (h > 0.93) jitter = h > 0.9475 ? 1 : -1;
      }
      const cov = this.cellCov[k]!;
      v *= 0.5 + 0.5 * Math.min(1, cov * 1.3);
      if (v > 1) v = 1;

      const level = Math.max(0, Math.min(LEVELS - 1, Math.round(v * (LEVELS - 1))));
      let g = Math.round(1.6 + ((v - 0.4) / 0.6) * 4.2) + this.cellDensity[k]! + jitter;
      if (cov < 0.35) g = Math.min(g, 1);
      g = Math.max(0, Math.min(rampLen - 1, g));

      // Whole device pixels: an unscaled, unfiltered blit is the fastest path.
      const a = atlases[level >= GLOW_FROM ? 1 : 0];
      ctx.drawImage(
        a.canvas,
        (this.cellMat[k]! * rampLen + g) * a.w,
        (level - a.from) * a.h,
        a.w,
        a.h,
        Math.round((x + dx) * dpr - a.w / 2),
        Math.round((y + dy) * dpr - a.h / 2),
        a.w,
        a.h,
      );
    }
  }
}
