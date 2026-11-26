import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { InkTool } from "./model";

/** Per-tool outline behaviour. */
export const TOOL_STROKE_OPTIONS: Record<InkTool, StrokeOptions> = {
  pen: {
    thinning: 0.55,
    smoothing: 0.55,
    streamline: 0.5,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  },
  pencil: {
    thinning: 0.7,
    smoothing: 0.35,
    streamline: 0.3,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  },
  highlighter: {
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.6,
    start: { cap: false, taper: 0 },
    end: { cap: false, taper: 0 },
  },
};

/** Converts flat x,y,p points to perfect-freehand input. */
function toInput(points: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < points.length; i += 3) out.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  return out;
}

/** Outline polygon of a stroke in world coordinates. */
export function strokeOutline(
  points: readonly number[],
  tool: InkTool,
  size: number,
  simulatePressure: boolean,
  complete: boolean,
): number[][] {
  const options = TOOL_STROKE_OPTIONS[tool];
  return getStroke(toInput(points), {
    ...options,
    // Without a pen's pressure the width follows speed; keep that subtle so lines look even.
    thinning: simulatePressure ? (options.thinning ?? 0) * 0.45 : options.thinning,
    size,
    simulatePressure,
    last: complete,
  });
}

const avg = (a: number, b: number) => (a + b) / 2;
const f = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * Smooth closed SVG path through an outline polygon: a quadratic curve to the
 * midpoint of each edge, with the vertex as control point. Every control point
 * is written out: the shorthand "T" reflects the previous one, so rounding
 * errors would add up along the stroke and make long strokes wobble.
 */
export function outlineToSvgPath(outline: readonly number[][]): string {
  const len = outline.length;
  if (len < 4) return "";
  const parts = [`M${f(outline[0]![0]!)},${f(outline[0]![1]!)}`];
  for (let i = 1; i < len - 1; i++) {
    const a = outline[i]!;
    const b = outline[i + 1]!;
    parts.push(`Q${f(a[0]!)},${f(a[1]!)} ${f(avg(a[0]!, b[0]!))},${f(avg(a[1]!, b[1]!))}`);
  }
  return `${parts.join("")}Z`;
}

/** The same path as {@link outlineToSvgPath} for a canvas, built directly at full precision. */
export function outlinePath(outline: readonly number[][]): Path2D {
  const path = new Path2D();
  const len = outline.length;
  if (len < 4) return path;
  path.moveTo(outline[0]![0]!, outline[0]![1]!);
  for (let i = 1; i < len - 1; i++) {
    const a = outline[i]!;
    const b = outline[i + 1]!;
    path.quadraticCurveTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2);
  }
  path.closePath();
  return path;
}

/** True if the recorded pressures carry no information (mouse, or pen driver without pressure). */
export function needsSimulatedPressure(pointerType: string, points: readonly number[]): boolean {
  if (pointerType !== "pen") return true;
  if (points.length < 6) return false;
  const first = points[2]!;
  for (let i = 5; i < points.length; i += 3) if (Math.abs(points[i]! - first) > 1e-3) return false;
  return true;
}
