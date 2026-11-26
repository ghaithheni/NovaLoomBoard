import type { Camera } from "./camera";
import { outlinePath } from "./ink";
import { LiveOutline } from "./liveInk";
import type { InkTool, StrokeStyle } from "./model";

/** Settled stroke points gathered before they are painted into the cache. */
const CHUNK = 32;
/** Outline vertices by which a piece reaches back into the previous one. */
const OVERLAP_VERTICES = 2;

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface LiveInkStyle {
  tool: InkTool;
  style: StrokeStyle;
  points: readonly number[];
  simulatePressure: boolean;
  /** Predicted points drawn after the real ones, this frame only. */
  predicted?: readonly number[];
  /** Fill colour and opacity, as the stroke will be drawn. */
  color: string;
  alpha: number;
}

/**
 * Draws the stroke being drawn without redrawing all of it on every frame.
 *
 * The settled part of the outline (see {@link LiveOutline}) is painted once,
 * piece by piece, into a cache the size of the canvas. Each frame copies the
 * cache and fills only the tail. Pieces and the tail overlap a little, so the
 * edges where they meet lie inside ink and leave no seam. Everything is
 * painted opaque and the result drawn at the stroke's opacity, so overlaps
 * never show as darker ink.
 */
export class LiveStrokeLayer {
  private readonly outline = new LiveOutline();
  private cache: Canvas | null = null;
  private cacheCtx: Ctx | null = null;
  private compose: Canvas | null = null;
  private composeCtx: Ctx | null = null;
  /** Last settled stroke point painted into the cache, or -1. */
  private painted = -1;
  /** What the cache was painted for: the stroke, camera, canvas size and colour. */
  private key = "";
  private points: readonly number[] | null = null;
  /** Area of the cache holding ink, in canvas pixels. */
  private dirty = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  draw(ctx: CanvasRenderingContext2D, live: LiveInkStyle, cam: Camera, dpr: number): void {
    const { width, height } = ctx.canvas;
    const o = this.outline;
    o.update(live.points, live.tool, live.style.size, live.simulatePressure, live.predicted);

    const key = `${cam.x},${cam.y},${cam.zoom},${width},${height},${dpr},${live.color}`;
    if (live.points !== this.points || key !== this.key || o.settledCount < this.painted + 1) {
      this.points = live.points;
      this.key = key;
      this.restart(width, height);
    }
    const k = dpr * cam.zoom;
    const toCanvas = (c: Ctx) => c.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);

    // Paint newly settled points into the cache, a chunk at a time.
    const settled = o.settledCount;
    if (settled - 1 - this.painted >= CHUNK) {
      const c = this.cacheContext(width, height);
      if (c) {
        const from = this.painted < 0 ? 0 : this.overlapStart(this.painted, live.style.size, k);
        const piece = o.piece(from, settled - 1);
        toCanvas(c);
        c.fillStyle = live.color;
        c.fill(outlinePath(piece));
        this.grow(piece, k, cam);
        this.painted = settled - 1;
      }
    }

    const tail = o.tail(this.painted < 0 ? -1 : this.overlapStart(this.painted, live.style.size, k));
    const opaque = live.alpha >= 1;
    const target: Ctx | null = opaque ? ctx : this.composeContext(width, height);
    if (!target) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (!opaque) {
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, width, height);
    }
    this.copyCache(target);
    toCanvas(target);
    target.fillStyle = live.color;
    target.fill(outlinePath(tail));
    if (!opaque) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = live.alpha;
      ctx.drawImage(this.compose!, 0, 0);
    }
    ctx.restore();
  }

  /** Forgets the stroke (it was committed or cancelled). The canvases are kept for the next one. */
  reset(): void {
    this.points = null;
    this.key = "";
    this.painted = -1;
  }

  private restart(width: number, height: number): void {
    this.painted = -1;
    const c = this.cacheContext(width, height);
    if (c && this.dirty.maxX >= this.dirty.minX) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, width, height);
    }
    this.dirty = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  }

  /** The settled point a piece starting after `end` reaches back to. */
  private overlapStart(end: number, size: number, k: number): number {
    const o = this.outline;
    const at = o.verticesAt(end);
    // At least a stroke width and two canvas pixels back, and past a couple of outline vertices.
    const reach = Math.max(size, 2 / k);
    let s = end;
    while (s > 0) {
      const v = o.verticesAt(s);
      if (o.lengthAt(end) - o.lengthAt(s) >= reach && at.left - v.left >= OVERLAP_VERTICES && at.right - v.right >= OVERLAP_VERTICES) break;
      s--;
    }
    return s;
  }

  private copyCache(target: Ctx): void {
    const d = this.dirty;
    if (!this.cache || d.maxX < d.minX) return;
    const x = Math.max(0, Math.floor(d.minX));
    const y = Math.max(0, Math.floor(d.minY));
    const w = Math.min(this.cache.width, Math.ceil(d.maxX)) - x;
    const h = Math.min(this.cache.height, Math.ceil(d.maxY)) - y;
    if (w <= 0 || h <= 0) return;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(this.cache, x, y, w, h, x, y, w, h);
  }

  private grow(outline: readonly number[][], k: number, cam: Camera): void {
    const d = this.dirty;
    for (const p of outline) {
      const x = (p[0]! - cam.x) * k;
      const y = (p[1]! - cam.y) * k;
      if (x < d.minX) d.minX = x;
      if (y < d.minY) d.minY = y;
      if (x > d.maxX) d.maxX = x;
      if (y > d.maxY) d.maxY = y;
    }
    // Room for antialiasing and the curves between vertices.
    d.minX -= 2;
    d.minY -= 2;
    d.maxX += 2;
    d.maxY += 2;
  }

  private cacheContext(width: number, height: number): Ctx | null {
    if (!this.cache || this.cache.width !== width || this.cache.height !== height) {
      this.cache = makeCanvas(width, height);
      this.cacheCtx = this.cache ? (this.cache.getContext("2d") as Ctx | null) : null;
      this.dirty = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    }
    return this.cacheCtx;
  }

  private composeContext(width: number, height: number): Ctx | null {
    if (!this.compose || this.compose.width !== width || this.compose.height !== height) {
      this.compose = makeCanvas(width, height);
      this.composeCtx = this.compose ? (this.compose.getContext("2d") as Ctx | null) : null;
    }
    return this.composeCtx;
  }
}

function makeCanvas(width: number, height: number): Canvas | null {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  return null;
}
