import type { Camera } from "./camera";
import { viewportBounds, worldToScreen } from "./camera";
import { drawObject, drawShape, linePath, PathCache, strokeDashed } from "./draw";
import { LiveStrokeLayer } from "./liveLayer";
import type { Matrix } from "./matrix";
import { drawGuide, drawReadout, type Guide } from "./guides";
import type { BoardObject, Bounds, InkTool, Page, ShapeObject, StrokeStyle } from "./model";
import { highlighterOpacity, inkColor, isDarkBackground, paperColor, parseBackground, patternGeometry, type Background } from "./paper";
import { frameCorners, type Frame } from "./objects";
import { CORNER_HANDLES, handlePoint, rotationHandlePoint, SIDE_HANDLES, type Handle } from "./selection";
import type { SpatialIndex } from "./spatial";

export type { Background } from "./paper";

export interface LiveStroke {
  tool: InkTool;
  style: StrokeStyle;
  points: number[];
  simulatePressure: boolean;
  /** Where the pen is predicted to go (x, y, p), drawn for one frame; never part of the stroke. */
  predicted?: readonly number[];
}

export interface Cursor {
  x: number;
  y: number;
  radius: number;
}

/** Everything drawn on the active (top) layer, above committed content. */
export interface Overlay {
  live?: LiveStroke | null;
  liveShape?: Omit<ShapeObject, "id" | "bounds"> | null;
  /** Objects being moved, resized or rotated, drawn with the pending transform. */
  preview?: { objects: readonly BoardObject[]; transform: Matrix } | null;
  /** Selection frame (world coordinates) and which handles it offers (all sides, or only those listed). */
  selection?: { frame: Frame; corners: boolean; sides: boolean | readonly Handle[]; rotate: boolean; label?: string } | null;
  /** Rubber-band rectangle in world coordinates. */
  marquee?: Bounds | null;
  /** Lasso being drawn: flat [x0, y0, x1, y1, …] in world coordinates. */
  lasso?: readonly number[] | null;
  /** Padlock badges on locked objects: centres in screen pixels (fixed size at every zoom). */
  locks?: readonly { x: number; y: number }[] | null;
  cursor?: Cursor | null;
  /** The page is a dark board: dark ink is drawn light. */
  dark?: boolean;
  /** Ruler and protractor (screen pixels), with the zoom their scales measure. */
  guides?: readonly Guide[] | null;
  zoom?: number;
  /** Laser pointer: fading trails (world coordinates, timestamps in ms) and the dot (screen pixels). */
  laser?: { trails: readonly (readonly LaserPoint[])[]; now: number; dot: { x: number; y: number } | null } | null;
  /** A reading next to the pointer, such as an angle along the protractor (screen pixels). */
  readout?: { x: number; y: number; text: string } | null;
}

export interface LaserPoint {
  x: number;
  y: number;
  t: number;
}

/** How long a laser trail stays visible, in milliseconds. */
export const LASER_FADE_MS = 900;
const LASER_COLOR = "#ff2d2d";

/** Handle size in screen pixels. */
export const HANDLE_SIZE = 9;
/** Distance of the rotation handle above the frame, in screen pixels. */
export const ROTATE_HANDLE_OFFSET = 26;
const ROTATE_HANDLE_RADIUS = 6;

const ACCENT = "#0b7a75";
const ACCENT_FILL = "rgba(11, 122, 117, 0.07)";

/** Two-layer canvas renderer: committed content, and live input plus overlays. */
export class Renderer {
  private readonly sctx: CanvasRenderingContext2D;
  private readonly actx: CanvasRenderingContext2D;
  private readonly paths = new PathCache();
  private readonly liveLayer = new LiveStrokeLayer();
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(
    private readonly staticCanvas: HTMLCanvasElement,
    private readonly activeCanvas: HTMLCanvasElement,
  ) {
    const s = staticCanvas.getContext("2d", { alpha: false });
    const a = activeCanvas.getContext("2d", { desynchronized: true }) ?? activeCanvas.getContext("2d");
    if (!s || !a) throw new Error("Canvas 2D is not available");
    this.sctx = s;
    this.actx = a;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    for (const c of [this.staticCanvas, this.activeCanvas]) {
      c.width = Math.max(1, Math.round(width * dpr));
      c.height = Math.max(1, Math.round(height * dpr));
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
  }

  forget(id: string): void {
    this.paths.forget(id);
  }

  private applyCamera(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const k = this.dpr * cam.zoom;
    ctx.setTransform(k, 0, 0, k, -cam.x * k, -cam.y * k);
  }

  /** Draws committed content; `hidden` objects (being edited or transformed) are skipped. */
  renderStatic(page: Page, index: SpatialIndex, cam: Camera, background: Background, hidden: ReadonlySet<string>): number {
    const ctx = this.sctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = paperColor(background);
    ctx.fillRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    drawBackgroundPattern(ctx, cam, background, this.width, this.height, this.dpr);
    const dark = isDarkBackground(background);

    const view = viewportBounds(cam, this.width, this.height);
    const visible = new Set(index.search(view));
    this.applyCamera(ctx, cam);
    let drawn = 0;
    for (const id of page.order) {
      if (!visible.has(id) || hidden.has(id)) continue;
      const obj = page.objects.get(id);
      if (!obj) continue;
      drawObject(ctx, obj, this.paths, false, dark);
      drawn++;
    }
    return drawn;
  }

  renderActive(cam: Camera, o: Overlay): void {
    const ctx = this.actx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);

    if (o.preview) {
      this.applyCamera(ctx, cam);
      const t = o.preview.transform;
      ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
      for (const obj of o.preview.objects) drawObject(ctx, obj, this.paths, true, o.dark);
    }
    if (o.live && o.live.points.length >= 3) {
      this.applyCamera(ctx, cam);
      const { live } = o;
      if (live.style.dash && live.tool !== "highlighter") {
        ctx.globalAlpha = live.style.opacity;
        strokeDashed(ctx, linePath(live.points), live.style.size, live.style.dash, inkColor(live.style.color, !!o.dark));
        ctx.globalAlpha = 1;
      } else {
        const highlighter = live.tool === "highlighter";
        this.liveLayer.draw(
          ctx,
          {
            ...live,
            color: highlighter ? live.style.color : inkColor(live.style.color, !!o.dark),
            alpha: highlighter ? highlighterOpacity(live.style.opacity, !!o.dark) : live.style.opacity,
          },
          cam,
          this.dpr,
        );
      }
    } else {
      this.liveLayer.reset();
    }
    if (o.liveShape) {
      this.applyCamera(ctx, cam);
      drawShape(ctx, o.liveShape, o.dark);
    }

    // Screen-space overlays.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (o.marquee) {
      const a = worldToScreen(cam, o.marquee.minX, o.marquee.minY);
      const b = worldToScreen(cam, o.marquee.maxX, o.marquee.maxY);
      ctx.fillStyle = ACCENT_FILL;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.x - a.x), Math.round(b.y - a.y));
      ctx.setLineDash([]);
    }
    if (o.lasso && o.lasso.length >= 4) {
      ctx.beginPath();
      for (let i = 0; i < o.lasso.length; i += 2) {
        const q = worldToScreen(cam, o.lasso[i]!, o.lasso[i + 1]!);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.fillStyle = ACCENT_FILL;
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.locks) for (const p of o.locks) drawLockBadge(ctx, p.x, p.y);
    if (o.selection) this.drawSelection(cam, o.selection);
    if (o.guides) for (const g of o.guides) drawGuide(ctx, g, o.zoom ?? cam.zoom);
    if (o.laser) drawLaser(ctx, cam, o.laser);
    if (o.readout) drawReadout(ctx, o.readout.x, o.readout.y, o.readout.text);
    if (o.cursor) {
      ctx.beginPath();
      ctx.arc(o.cursor.x, o.cursor.y, o.cursor.radius, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(15, 23, 42, 0.55)";
      ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
      ctx.fill();
      ctx.stroke();
    }
  }

  private drawSelection(cam: Camera, sel: NonNullable<Overlay["selection"]>): void {
    const ctx = this.actx;
    // Work in screen pixels: the frame scaled by the zoom keeps its angle.
    const c = worldToScreen(cam, sel.frame.cx, sel.frame.cy);
    const f: Frame = { cx: c.x, cy: c.y, w: sel.frame.w * cam.zoom, h: sel.frame.h * cam.zoom, angle: sel.frame.angle };
    const corners = frameCorners(f);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    if (sel.rotate) {
      const top = handlePoint(f, "n");
      const r = rotationHandlePoint(f, ROTATE_HANDLE_OFFSET);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(r.x, r.y);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r.x, r.y, ROTATE_HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // A small turning arrow inside the handle.
      ctx.beginPath();
      ctx.arc(r.x, r.y, 2.6, -Math.PI * 0.9, Math.PI * 0.45);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    const sides = sel.sides === true ? SIDE_HANDLES : sel.sides === false ? [] : sel.sides;
    const handles = [...(sel.corners ? CORNER_HANDLES : []), ...sides];
    const half = HANDLE_SIZE / 2;
    ctx.lineWidth = 1.5;
    for (const h of handles) {
      const p = handlePoint(f, h);
      ctx.beginPath();
      ctx.roundRect(p.x - half, p.y - half, HANDLE_SIZE, HANDLE_SIZE, 2.5);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.stroke();
    }

    if (sel.label) {
      // Angle readout next to the rotation handle while rotating.
      const r = rotationHandlePoint(f, ROTATE_HANDLE_OFFSET + 26);
      ctx.font = "600 12px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
      const w = ctx.measureText(sel.label).width + 12;
      ctx.fillStyle = "#1c2026";
      ctx.beginPath();
      ctx.roundRect(r.x - w / 2, r.y - 11, w, 22, 6);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(sel.label, r.x, r.y);
      ctx.textAlign = "left";
    }
  }

}

/** The laser pointer: trails that fade out from their oldest end, and a glowing dot. */
function drawLaser(ctx: CanvasRenderingContext2D, cam: Camera, laser: NonNullable<Overlay["laser"]>): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = LASER_COLOR;
  for (const trail of laser.trails) {
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]!;
      const b = trail[i]!;
      const life = 1 - (laser.now - b.t) / LASER_FADE_MS;
      if (life <= 0) continue;
      const p = worldToScreen(cam, a.x, a.y);
      const q = worldToScreen(cam, b.x, b.y);
      ctx.globalAlpha = Math.min(1, life * 1.4);
      ctx.shadowBlur = 10;
      ctx.strokeStyle = LASER_COLOR;
      ctx.lineWidth = 2 + 3.5 * life;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
  }
  if (laser.dot) {
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 16;
    ctx.fillStyle = LASER_COLOR;
    ctx.beginPath();
    ctx.arc(laser.dot.x, laser.dot.y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255, 236, 236, 0.95)";
    ctx.beginPath();
    ctx.arc(laser.dot.x, laser.dot.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Size of the padlock badge on locked objects, in screen pixels. */
export const LOCK_BADGE_SIZE = 18;

/** A quiet padlock on a white chip (screen space), in the app's graphite. */
function drawLockBadge(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const s = LOCK_BADGE_SIZE;
  const r = 5;
  const left = x - s / 2;
  const top = y - s / 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(left, top, s, s, r);
  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.shadowColor = "rgba(28, 32, 38, 0.18)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(28, 32, 38, 0.12)";
  ctx.stroke();
  // Shackle and body.
  ctx.strokeStyle = "#3b414b";
  ctx.fillStyle = "#3b414b";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(x, y - 1.2, 2.6, Math.PI, 0);
  ctx.moveTo(x - 2.6, y - 1.2);
  ctx.lineTo(x - 2.6, y + 0.4);
  ctx.moveTo(x + 2.6, y - 1.2);
  ctx.lineTo(x + 2.6, y + 0.4);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(x - 4.2, y, 8.4, 5.6, 1.4);
  ctx.fill();
  ctx.restore();
}

/**
 * The page pattern for a viewport of `width`×`height` CSS pixels (see {@link patternGeometry}).
 * It is laid out in board units, so it pans and zooms with the board, and drawn in screen
 * pixels so lines stay crisp hairlines.
 */
export function drawBackgroundPattern(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  background: Background,
  width: number,
  height: number,
  dpr: number,
): void {
  const { pattern } = parseBackground(background);
  if (pattern === "blank") return;
  const region = { minX: cam.x, minY: cam.y, maxX: cam.x + width / cam.zoom, maxY: cam.y + height / cam.zoom };
  const geo = patternGeometry(pattern, region, cam.zoom, isDarkBackground(background));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (x: number) => (x - cam.x) * cam.zoom;
  const sy = (y: number) => (y - cam.y) * cam.zoom;
  // One path per line style; whole-pixel positions keep 1-pixel lines sharp.
  const groups = new Map<string, typeof geo.lines>();
  for (const l of geo.lines) {
    const key = `${l.color}|${l.width}|${l.dash?.join(",") ?? ""}`;
    const list = groups.get(key);
    if (list) list.push(l);
    else groups.set(key, [l]);
  }
  for (const lines of groups.values()) {
    const { color, width: w, dash } = lines[0]!;
    const crisp = (v: number) => (w <= 1 ? Math.round(v) + 0.5 : v);
    ctx.beginPath();
    for (const l of lines) {
      const x1 = sx(l.x1);
      const y1 = sy(l.y1);
      const x2 = sx(l.x2);
      const y2 = sy(l.y2);
      ctx.moveTo(x1 === x2 ? crisp(x1) : x1, y1 === y2 ? crisp(y1) : y1);
      ctx.lineTo(x1 === x2 ? crisp(x2) : x2, y1 === y2 ? crisp(y2) : y2);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.setLineDash(dash ? [...dash] : []);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (geo.dots.length) {
    ctx.fillStyle = geo.dots[0]!.color;
    ctx.beginPath();
    for (const d of geo.dots) {
      const x = sx(d.x);
      const y = sy(d.y);
      ctx.moveTo(x + d.r, y);
      ctx.arc(x, y, d.r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  if (geo.labels.length) {
    ctx.font = "500 11px 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
    for (const t of geo.labels) {
      ctx.fillStyle = t.color;
      ctx.textAlign = t.align;
      ctx.textBaseline = t.baseline;
      ctx.fillText(t.text, sx(t.x) + t.dx, sy(t.y) + t.dy);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
}
