/** Canvas drawing for each object type (world coordinates; caller sets the camera transform). */
import { outlinePath, strokeOutline } from "./ink";
import { assets } from "./assets";
import type { BoardObject, ImageObject, LineDash, ShapeObject, StrokeObject, TextObject } from "./model";
import { highlighterOpacity, inkColor } from "./paper";
import { arrowHead, shapeOutline, TEXT_LINE_HEIGHT } from "./objects";
import { fontString, layoutLines } from "./text-layout";

/** Cache of stroke outlines (strokes are immutable, so the id identifies the geometry). */
export class PathCache {
  /**
   * Keyed by the object itself: objects are immutable (a moved stroke is a
   * new object), so an outline can never be stale, and outlines of pages
   * visited earlier are reused when returning to them.
   */
  private readonly paths = new WeakMap<StrokeObject, Path2D>();
  private readonly lines = new WeakMap<StrokeObject, Path2D>();
  /** Whether images drawn through this cache count as on screen (thumbnails do not). */
  readonly pinsImages: boolean = true;

  get(obj: StrokeObject): Path2D {
    let path = this.paths.get(obj);
    if (!path) {
      const outline = strokeOutline(obj.points, obj.tool, obj.style.size, obj.simulatePressure, true);
      path = outlinePath(outline);
      this.paths.set(obj, path);
    }
    return path;
  }

  /** The centre line of a stroke (dashed and dotted ink is stroked along it). */
  getLine(obj: StrokeObject): Path2D {
    let path = this.lines.get(obj);
    if (!path) {
      path = linePath(obj.points);
      this.lines.set(obj, path);
    }
    return path;
  }

  /** Kept for callers; entries go away with their objects. */
  forget(_id: string): void {}
}

/**
 * Draws one object. On a dark board (`dark`) dark ink is drawn light, see {@link inkColor};
 * highlighter brightens instead of darkening what is under it.
 */
export function drawObject(ctx: CanvasRenderingContext2D, obj: BoardObject, paths: PathCache, live = false, dark = false): void {
  switch (obj.type) {
    case "stroke":
      ctx.globalAlpha = obj.tool === "highlighter" ? highlighterOpacity(obj.style.opacity, dark) : obj.style.opacity;
      // Blending needs the content underneath, which a live (separate) layer does not have.
      ctx.globalCompositeOperation = obj.tool === "highlighter" && !live ? (dark ? "screen" : "multiply") : "source-over";
      if (obj.style.dash && obj.tool !== "highlighter") {
        strokeDashed(ctx, paths.getLine(obj), obj.style.size, obj.style.dash, inkColor(obj.style.color, dark));
        break;
      }
      ctx.fillStyle = obj.tool === "highlighter" ? obj.style.color : inkColor(obj.style.color, dark);
      ctx.fill(paths.get(obj));
      break;
    case "shape":
      drawShape(ctx, obj, dark);
      break;
    case "text":
      drawText(ctx, obj, dark);
      break;
    case "image":
      drawImage(ctx, obj, paths.pinsImages);
      break;
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

/** A polyline through x, y, pressure triples. */
export function linePath(points: readonly number[]): Path2D {
  const p = new Path2D();
  p.moveTo(points[0]!, points[1]!);
  for (let i = 3; i < points.length; i += 3) p.lineTo(points[i]!, points[i + 1]!);
  return p;
}

/** Dash lengths for a line of width `size`: dots are zero-length dashes with round caps. */
export function dashPattern(dash: LineDash, size: number): number[] {
  return dash === "dotted" ? [0.001, size * 2.4] : [size * 3, size * 2.4];
}

export function strokeDashed(ctx: CanvasRenderingContext2D, path: Path2D, size: number, dash: LineDash, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dashPattern(dash, size));
  ctx.stroke(path);
  ctx.setLineDash([]);
}

export function drawShape(ctx: CanvasRenderingContext2D, s: Omit<ShapeObject, "id" | "bounds">, dark = false): void {
  const { pts, closed } = shapeOutline(s);
  const color = inkColor(s.style.color, dark);
  const path = new Path2D();
  path.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i]!, pts[i + 1]!);
  if (closed) path.closePath();
  ctx.globalCompositeOperation = "source-over";
  if (closed && s.style.fill !== "none") {
    ctx.globalAlpha = s.style.opacity * (s.style.fill === "tint" ? 0.16 : 1);
    ctx.fillStyle = color;
    ctx.fill(path);
  }
  ctx.globalAlpha = s.style.opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = s.style.size;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (s.kind === "arrow") {
    // Stop the shaft inside the head so its round cap does not poke through the tip.
    const h = arrowHead(s as ShapeObject);
    const shaft = new Path2D();
    shaft.moveTo(s.x1, s.y1);
    shaft.lineTo((h[2]! + h[4]!) / 2, (h[3]! + h[5]!) / 2);
    if (s.style.dash) ctx.setLineDash(dashPattern(s.style.dash, s.style.size));
    ctx.stroke(shaft);
    ctx.setLineDash([]);
    const head = new Path2D();
    head.moveTo(h[0]!, h[1]!);
    head.lineTo(h[2]!, h[3]!);
    head.lineTo(h[4]!, h[5]!);
    head.closePath();
    ctx.fillStyle = color;
    ctx.lineWidth = Math.min(s.style.size, 3);
    ctx.fill(head);
    ctx.stroke(head);
  } else {
    if (s.style.dash) ctx.setLineDash(dashPattern(s.style.dash, s.style.size));
    ctx.stroke(path);
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

/** An image at full quality; a quiet placeholder while its pixels load (or if they are missing). */
export function drawImage(ctx: CanvasRenderingContext2D, img: ImageObject, pin = true): void {
  // The size it is shown at, in device pixels: picks a copy that is just sharp enough.
  const t = ctx.getTransform();
  const shown = Math.max(img.width, img.height) * Math.hypot(t.a, t.b);
  ctx.save();
  ctx.translate(img.cx, img.cy);
  if (img.rotation) ctx.rotate(img.rotation);
  const x = -img.width / 2;
  const y = -img.height / 2;
  const bitmap = assets.get(img.asset, shown, pin);
  if (bitmap) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, x, y, img.width, img.height);
    if (img.locked) {
      // A page background (imported PDF page): a hairline edge shows the sheet on a blank board.
      const k = ctx.getTransform();
      ctx.lineWidth = 1 / Math.max(1e-6, Math.hypot(k.a, k.b));
      ctx.strokeStyle = "rgba(28, 32, 38, 0.18)";
      ctx.strokeRect(x, y, img.width, img.height);
    }
  } else {
    ctx.fillStyle = "#eef0f3";
    ctx.fillRect(x, y, img.width, img.height);
    if (assets.isMissing(img.asset)) {
      // Missing pixels: a crossed box, so the object can still be found and deleted.
      ctx.strokeStyle = "#b9bec7";
      const k = ctx.getTransform();
      ctx.lineWidth = 1.5 / Math.max(1e-6, Math.hypot(k.a, k.b));
      ctx.strokeRect(x, y, img.width, img.height);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + img.width, y + img.height);
      ctx.moveTo(x + img.width, y);
      ctx.lineTo(x, y + img.height);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawText(ctx: CanvasRenderingContext2D, t: TextObject, dark = false): void {
  const lh = t.style.fontSize * TEXT_LINE_HEIGHT;
  ctx.save();
  if (t.rotation) {
    ctx.translate(t.x, t.y);
    ctx.rotate(t.rotation);
    ctx.translate(-t.x, -t.y);
  }
  ctx.font = fontString(t.style);
  ctx.fillStyle = inkColor(t.style.color, dark);
  ctx.textAlign = t.style.align;
  // Place the baseline exactly where a DOM line box puts it (half-leading + ascent),
  // so text does not shift when the editor closes.
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("Hg");
  const ascent = m.fontBoundingBoxAscent;
  const baseline = (lh - (ascent + m.fontBoundingBoxDescent)) / 2 + ascent;
  const x = t.style.align === "left" ? t.x : t.style.align === "center" ? t.x + t.width / 2 : t.x + t.width;
  layoutLines(t.text, t.style, t.boxWidth).forEach((line, i) => {
    if (!line.text) return;
    ctx.direction = line.dir;
    ctx.fillText(line.text, x, t.y + lh * i + baseline);
  });
  ctx.restore();
}
