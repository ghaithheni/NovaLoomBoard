/**
 * Incremental outline of the stroke being drawn.
 *
 * Recomputing a stroke's whole outline on every frame gets slower as the
 * stroke grows. Almost all of it never changes again, though: perfect-freehand
 * computes each point from the one before, so a point's outline is final once
 * a few newer points exist. This keeps that settled part and only recomputes
 * the last few points (the tail) when new input arrives.
 *
 * The result is exactly what `strokeOutline(points, tool, size,
 * simulatePressure, false)` returns (see liveInk.test.ts). The algorithm is
 * adapted from perfect-freehand 1.2.3 (`getStrokePoints` and
 * `getStrokeOutlinePoints`), MIT License, Copyright (c) 2021 Stephen Ruiz Ltd,
 * restricted to the options the tools use (no tapering, linear easing, the
 * stroke not yet complete).
 */
import type { InkTool } from "./model";
import { TOOL_STROKE_OPTIONS } from "./ink";

type Vec = [number, number];

const FIXED_PI = Math.PI + 0.0001;
const START_CAP_SEGMENTS = 13;
const END_CAP_SEGMENTS = 29;
const CORNER_CAP_SEGMENTS = 13;
const END_NOISE_THRESHOLD = 3;
const MIN_STREAMLINE_T = 0.15;
const STREAMLINE_T_RANGE = 0.85;
const MIN_RADIUS = 0.01;
const DEFAULT_FIRST_PRESSURE = 0.25;
const DEFAULT_PRESSURE = 0.5;
const RATE_OF_PRESSURE_CHANGE = 0.275;
/** Stroke points that set the starting pressure. */
const INITIAL_PRESSURE_POINTS = 10;

interface StrokePoint {
  point: Vec;
  pressure: number;
  vector: Vec;
  distance: number;
  runningLength: number;
}

/** State of the stroke-point pass after the last settled input point. */
interface PointsState {
  prev: StrokePoint;
  runningLength: number;
  reachedMinimumLength: boolean;
}

/** State of the outline pass after the last settled stroke point. */
interface OutlineState {
  prevPressure: number;
  prevVector: Vec;
  prevLeft: Vec;
  prevRight: Vec;
  prevSharpCorner: boolean;
}

const per = (a: Vec): Vec => [a[1], -a[0]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const dist2 = (a: Vec, b: Vec) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
function rotAround(a: Vec, c: Vec, r: number): Vec {
  const s = Math.sin(r);
  const k = Math.cos(r);
  const px = a[0] - c[0];
  const py = a[1] - c[1];
  return [px * k - py * s + c[0], px * s + py * k + c[1]];
}
function unit(a: Vec): Vec {
  const l = Math.hypot(a[0], a[1]);
  return [a[0] / l, a[1] / l];
}
function simulatePressure(prev: number, distance: number, size: number): number {
  const sp = Math.min(1, distance / size);
  const rp = Math.min(1, 1 - sp);
  return Math.min(1, prev + (rp - prev) * (sp * RATE_OF_PRESSURE_CHANGE));
}
const validPressure = (p: number | undefined): p is number => p != null && p >= 0;

export class LiveOutline {
  private points: readonly number[] | null = null;
  private tool: InkTool = "pen";
  private size = 0;
  private simulate = false;

  // Options, as strokeOutline passes them to perfect-freehand.
  private streamT = 0;
  private thinning = 0;
  private minDistance = 0;
  private capStart = true;
  private capEnd = true;

  /** Settled stroke points, and the state after the last one. */
  private stroke: StrokePoint[] = [];
  private pointsState: PointsState | null = null;
  /** Input points (x, y, p triples) consumed into `stroke`. */
  private inputsDone = 0;

  /** Settled outline: left and right sides, and how many of each existed after each settled stroke point. */
  private left: Vec[] = [];
  private right: Vec[] = [];
  private leftCount: number[] = [];
  private rightCount: number[] = [];
  private outlineState: OutlineState | null = null;
  private initialPressure = 0;

  /** The tail, rebuilt by update(): stroke points after the settled ones, and their outline. */
  private tailStroke: StrokePoint[] = [];
  private tailLeft: Vec[] = [];
  private tailRight: Vec[] = [];
  private endCap: Vec[] = [];
  private startCap: Vec[] = [];
  private dot: Vec[] | null = null;

  /** Predicted input points (x, y, p) drawn after the real ones; they only ever reach the tail. */
  private extra: readonly number[] = [];

  /**
   * Brings the outline up to date. `points` may only grow between calls;
   * anything else starts over. `predicted` points, if any, extend the tail
   * for this call only: the settled outline never depends on them, and they
   * are ignored while the stroke has fewer than three real points.
   */
  update(points: readonly number[], tool: InkTool, size: number, simulatePressure: boolean, predicted: readonly number[] = []): void {
    this.extra = predicted;
    if (
      points !== this.points ||
      tool !== this.tool ||
      size !== this.size ||
      simulatePressure !== this.simulate ||
      points.length < this.inputsDone * 3
    ) {
      this.reset(points, tool, size, simulatePressure);
    }
    this.advance();
  }

  /** Number of settled stroke points; their outline never changes again. */
  get settledCount(): number {
    return this.leftCount.length;
  }

  /** Distance along the stroke at settled stroke point `i`. */
  lengthAt(i: number): number {
    return this.stroke[i]!.runningLength;
  }

  /** Left and right outline vertices that existed once settled stroke point `i` was done. */
  verticesAt(i: number): { left: number; right: number } {
    return { left: this.leftCount[i]!, right: this.rightCount[i]! };
  }

  /**
   * Closed outline of the settled stroke between settled points `from` and
   * `to` (inclusive), with the start cap when `from` is 0.
   */
  piece(from: number, to: number): number[][] {
    const l0 = from === 0 ? 0 : Math.max(0, this.leftCount[from]! - 1);
    const r0 = from === 0 ? 0 : Math.max(0, this.rightCount[from]! - 1);
    const out: number[][] = this.left.slice(l0, this.leftCount[to]);
    const right = this.right.slice(r0, this.rightCount[to]).reverse();
    for (const p of right) out.push(p);
    if (from === 0) for (const p of this.startCap) out.push(p);
    return out;
  }

  /** Closed outline from settled point `from` (or the start, if -1) to the end of the stroke. */
  tail(from: number): number[][] {
    if (this.dot) return this.dot;
    const start = from <= 0;
    const l0 = start ? 0 : Math.max(0, this.leftCount[from]! - 1);
    const r0 = start ? 0 : Math.max(0, this.rightCount[from]! - 1);
    const out: number[][] = this.left.slice(l0);
    for (const p of this.tailLeft) out.push(p);
    for (const p of this.endCap) out.push(p);
    for (let i = this.tailRight.length - 1; i >= 0; i--) out.push(this.tailRight[i]!);
    for (let i = this.right.length - 1; i >= r0; i--) out.push(this.right[i]!);
    if (start) for (const p of this.startCap) out.push(p);
    return out;
  }

  /** The whole outline, the same as strokeOutline(…, false). */
  outline(): number[][] {
    return this.tail(-1);
  }

  private reset(points: readonly number[], tool: InkTool, size: number, simulatePressure: boolean): void {
    this.points = points;
    this.tool = tool;
    this.size = size;
    this.simulate = simulatePressure;
    const o = TOOL_STROKE_OPTIONS[tool];
    this.streamT = MIN_STREAMLINE_T + (1 - (o.streamline ?? 0.5)) * STREAMLINE_T_RANGE;
    this.thinning = simulatePressure ? (o.thinning ?? 0) * 0.45 : (o.thinning ?? 0.5);
    this.minDistance = (size * (o.smoothing ?? 0.5)) ** 2;
    this.capStart = o.start?.cap ?? true;
    this.capEnd = o.end?.cap ?? true;
    this.stroke = [];
    this.pointsState = null;
    this.inputsDone = 0;
    this.left = [];
    this.right = [];
    this.leftCount = [];
    this.rightCount = [];
    this.outlineState = null;
  }

  private advance(): void {
    const pts = this.points!;
    const n = pts.length / 3;
    this.dot = null;
    this.tailStroke = [];
    this.tailLeft = [];
    this.tailRight = [];
    this.endCap = [];
    this.startCap = [];
    if (n === 0 || this.size <= 0) return;
    if (n < 3) {
      this.shortStroke(pts, n);
      return;
    }

    // ---- Stroke points (getStrokePoints). Every input but the last is settled.
    if (!this.pointsState) {
      const first: StrokePoint = {
        point: [pts[0]!, pts[1]!],
        pressure: validPressure(pts[2]) ? pts[2] : DEFAULT_FIRST_PRESSURE,
        vector: [1, 1],
        distance: 0,
        runningLength: 0,
      };
      this.stroke.push(first);
      this.pointsState = { prev: first, runningLength: 0, reachedMinimumLength: false };
      this.inputsDone = 1;
    }
    for (; this.inputsDone < n - 1; this.inputsDone++) {
      const i = this.inputsDone * 3;
      const p = this.strokePoint(this.pointsState, pts[i]!, pts[i + 1]!, pts[i + 2], false);
      if (p) this.stroke.push(p);
    }
    const lastState = { ...this.pointsState };
    const li = (n - 1) * 3;
    const extra = this.extra;
    // Where the real stroke ends, as if nothing were predicted: settling depends only on real input.
    let realTotal: number;
    if (extra.length < 3) {
      const last = this.strokePoint(lastState, pts[li]!, pts[li + 1]!, pts[li + 2], true);
      if (last) this.tailStroke.push(last);
      realTotal = (last ?? this.stroke[this.stroke.length - 1]!).runningLength;
    } else {
      const probe = this.strokePoint({ ...this.pointsState }, pts[li]!, pts[li + 1]!, pts[li + 2], true);
      realTotal = (probe ?? this.stroke[this.stroke.length - 1]!).runningLength;
      const last = this.strokePoint(lastState, pts[li]!, pts[li + 1]!, pts[li + 2], false);
      if (last) this.tailStroke.push(last);
      for (let j = 0; j + 2 < extra.length; j += 3) {
        const q = this.strokePoint(lastState, extra[j]!, extra[j + 1]!, extra[j + 2], j + 3 >= extra.length);
        if (q) this.tailStroke.push(q);
      }
    }

    const all = this.tailStroke.length ? this.stroke.concat(this.tailStroke) : this.stroke;
    const count = all.length;
    // The first point takes the direction of the second (provisional until the second is settled).
    const firstVector: Vec = all[1] ? all[1].vector : [0, 0];

    // ---- Outline (getStrokeOutlinePoints).
    const total = all[count - 1]!.runningLength;
    const ip = this.computeInitialPressure(all);
    const initialSettled = this.stroke.length >= INITIAL_PRESSURE_POINTS + 1;
    if (initialSettled && !this.outlineState) this.initialPressure = ip;
    if (!initialSettled) {
      // Not enough settled points yet: compute everything as tail.
      this.left = [];
      this.right = [];
      this.leftCount = [];
      this.rightCount = [];
      this.outlineState = null;
    }
    const vectorOf = (i: number): Vec => (i === 0 ? firstVector : all[i]!.vector);

    if (initialSettled) {
      // Settle points whose next point is settled and that are far enough from the end.
      if (!this.outlineState) {
        this.outlineState = { prevPressure: this.initialPressure, prevVector: vectorOf(0), prevLeft: all[0]!.point, prevRight: all[0]!.point, prevSharpCorner: false };
      }
      const settleBefore = this.stroke.length - 1; // point i needs point i+1 settled
      for (let i = this.leftCount.length; i < settleBefore; i++) {
        if (realTotal - all[i]!.runningLength < END_NOISE_THRESHOLD) break;
        this.outlinePoint(this.outlineState, all, i, count, vectorOf, this.left, this.right);
        this.leftCount.push(this.left.length);
        this.rightCount.push(this.right.length);
      }
    }

    const state: OutlineState = this.outlineState
      ? { ...this.outlineState }
      : { prevPressure: ip, prevVector: vectorOf(0), prevLeft: all[0]!.point, prevRight: all[0]!.point, prevSharpCorner: false };
    let radius = 0;
    for (let i = this.leftCount.length; i < count; i++) {
      const isLast = i === count - 1;
      if (!isLast && total - all[i]!.runningLength < END_NOISE_THRESHOLD) continue;
      radius = this.outlinePoint(state, all, i, count, vectorOf, this.tailLeft, this.tailRight);
    }

    // ---- Caps.
    if (count === 1) {
      this.dot = drawDot([all[0]!.point[0], all[0]!.point[1]], radius);
      return;
    }
    const firstPoint: Vec = [all[0]!.point[0], all[0]!.point[1]];
    const lastPoint: Vec = [all[count - 1]!.point[0], all[count - 1]!.point[1]];
    const firstLeft = this.left[0] ?? this.tailLeft[0]!;
    const firstRight = this.right[0] ?? this.tailRight[0]!;
    this.startCap = this.capStart ? roundStartCap(firstPoint, firstRight) : flatStartCap(firstPoint, firstLeft, firstRight);
    const v = vectorOf(count - 1);
    const direction = per([-v[0], -v[1]]);
    this.endCap = this.capEnd ? roundEndCap(lastPoint, direction, radius) : flatEndCap(lastPoint, direction, radius);
  }

  /** Strokes of one or two input points: perfect-freehand interpolates them; nothing is settled. */
  private shortStroke(pts: readonly number[], n: number): void {
    this.reset(pts, this.tool, this.size, this.simulate);
    let input: number[][] = [];
    for (let i = 0; i < n; i++) input.push([pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!]);
    if (n === 2) {
      const a = input[0]!;
      const b = input[1]!;
      input = [a];
      for (let i = 1; i < 5; i++) input.push([a[0]! + (b[0]! - a[0]!) * (i / 4), a[1]! + (b[1]! - a[1]!) * (i / 4)]);
    } else {
      const a = input[0]!;
      input.push([a[0]! + 1, a[1]! + 1, ...a.slice(2)]);
    }
    const flat: number[] = [];
    for (const p of input) flat.push(p[0]!, p[1]!, p[2] ?? -1);
    // Run the general pass over the expanded input; -1 marks a missing pressure.
    this.inputsDone = 0;
    const m = flat.length / 3;
    const first: StrokePoint = {
      point: [flat[0]!, flat[1]!],
      pressure: validPressure(flat[2]) ? flat[2] : DEFAULT_FIRST_PRESSURE,
      vector: [1, 1],
      distance: 0,
      runningLength: 0,
    };
    const state: PointsState = { prev: first, runningLength: 0, reachedMinimumLength: false };
    const all: StrokePoint[] = [first];
    for (let i = 1; i < m; i++) {
      const p = this.strokePoint(state, flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2], i === m - 1);
      if (p) all.push(p);
    }
    this.stroke = [];
    this.pointsState = null;
    this.inputsDone = 0;
    const count = all.length;
    const firstVector: Vec = all[1] ? all[1].vector : [0, 0];
    const vectorOf = (i: number): Vec => (i === 0 ? firstVector : all[i]!.vector);
    const total = all[count - 1]!.runningLength;
    const os: OutlineState = { prevPressure: this.computeInitialPressure(all), prevVector: vectorOf(0), prevLeft: all[0]!.point, prevRight: all[0]!.point, prevSharpCorner: false };
    let radius = 0;
    for (let i = 0; i < count; i++) {
      if (i !== count - 1 && total - all[i]!.runningLength < END_NOISE_THRESHOLD) continue;
      radius = this.outlinePoint(os, all, i, count, vectorOf, this.tailLeft, this.tailRight);
    }
    if (count === 1) {
      this.dot = drawDot([all[0]!.point[0], all[0]!.point[1]], radius);
      return;
    }
    const firstPoint: Vec = [all[0]!.point[0], all[0]!.point[1]];
    const lastPoint: Vec = [all[count - 1]!.point[0], all[count - 1]!.point[1]];
    this.startCap = this.capStart ? roundStartCap(firstPoint, this.tailRight[0]!) : flatStartCap(firstPoint, this.tailLeft[0]!, this.tailRight[0]!);
    const v = vectorOf(count - 1);
    const direction = per([-v[0], -v[1]]);
    this.endCap = this.capEnd ? roundEndCap(lastPoint, direction, radius) : flatEndCap(lastPoint, direction, radius);
  }

  /** One input point of getStrokePoints; null when perfect-freehand would skip it. */
  private strokePoint(s: PointsState, x: number, y: number, pressure: number | undefined, isLast: boolean): StrokePoint | null {
    const prev = s.prev.point;
    const point: Vec = [prev[0] + (x - prev[0]) * this.streamT, prev[1] + (y - prev[1]) * this.streamT];
    if (prev[0] === point[0] && prev[1] === point[1]) return null;
    const distance = Math.hypot(prev[1] - point[1], prev[0] - point[0]);
    s.runningLength += distance;
    if (!isLast && !s.reachedMinimumLength) {
      if (s.runningLength < this.size) return null;
      s.reachedMinimumLength = true;
    }
    const p: StrokePoint = {
      point,
      pressure: validPressure(pressure) ? pressure : DEFAULT_PRESSURE,
      vector: unit([prev[0] - point[0], prev[1] - point[1]]),
      distance,
      runningLength: s.runningLength,
    };
    s.prev = p;
    return p;
  }

  private computeInitialPressure(points: readonly StrokePoint[]): number {
    let acc = points[0]!.pressure;
    const n = Math.min(points.length, INITIAL_PRESSURE_POINTS);
    for (let i = 0; i < n; i++) {
      const curr = points[i]!;
      const pressure = this.simulate ? simulatePressure(acc, curr.distance, this.size) : curr.pressure;
      acc = (acc + pressure) / 2;
    }
    return acc;
  }

  /** One stroke point of getStrokeOutlinePoints; returns its radius. */
  private outlinePoint(s: OutlineState, points: readonly StrokePoint[], i: number, count: number, vectorOf: (i: number) => Vec, left: Vec[], right: Vec[]): number {
    const isLast = i === count - 1;
    const { point, distance } = points[i]!;
    let pressure = points[i]!.pressure;
    const vector = vectorOf(i);
    let radius: number;
    if (this.thinning) {
      if (this.simulate) pressure = simulatePressure(s.prevPressure, distance, this.size);
      radius = this.size * (0.5 - this.thinning * (0.5 - pressure));
    } else {
      radius = this.size / 2;
    }
    radius = Math.max(MIN_RADIUS, radius);

    const nextVector = isLast ? vector : vectorOf(i + 1);
    const nextDpr = isLast ? 1.0 : dot(vector, nextVector);
    const prevDpr = dot(vector, s.prevVector);
    const isPointSharpCorner = prevDpr < 0 && !s.prevSharpCorner;
    const isNextPointSharpCorner = nextDpr < 0;

    if (isPointSharpCorner || isNextPointSharpCorner) {
      const ox = s.prevVector[1] * radius;
      const oy = -s.prevVector[0] * radius;
      const step = 1 / CORNER_CAP_SEGMENTS;
      let l: Vec = s.prevLeft;
      let r: Vec = s.prevRight;
      for (let t = 0; t <= 1; t += step) {
        l = rotAround([point[0] - ox, point[1] - oy], point, FIXED_PI * t);
        left.push(l);
        r = rotAround([point[0] + ox, point[1] + oy], point, FIXED_PI * -t);
        right.push(r);
      }
      s.prevLeft = l;
      s.prevRight = r;
      if (isNextPointSharpCorner) s.prevSharpCorner = true;
      return radius;
    }
    s.prevSharpCorner = false;

    if (isLast) {
      const ox = vector[1] * radius;
      const oy = -vector[0] * radius;
      left.push([point[0] - ox, point[1] - oy]);
      right.push([point[0] + ox, point[1] + oy]);
      return radius;
    }

    // lrp(nextVector, vector, nextDpr), perpendicular, times radius.
    const lx = nextVector[0] + (vector[0] - nextVector[0]) * nextDpr;
    const ly = nextVector[1] + (vector[1] - nextVector[1]) * nextDpr;
    const ox = ly * radius;
    const oy = -lx * radius;
    const l: Vec = [point[0] - ox, point[1] - oy];
    if (i <= 1 || dist2(s.prevLeft, l) > this.minDistance) {
      left.push(l);
      s.prevLeft = l;
    }
    const r: Vec = [point[0] + ox, point[1] + oy];
    if (i <= 1 || dist2(s.prevRight, r) > this.minDistance) {
      right.push(r);
      s.prevRight = r;
    }
    s.prevPressure = pressure;
    s.prevVector = vector;
    return radius;
  }
}

function drawDot(center: Vec, radius: number): Vec[] {
  // prj(center, uni(per(sub(center, add(center, [1, 1])))), -radius), in the same floating-point steps.
  const d = unit(per([center[0] - (center[0] + 1), center[1] - (center[1] + 1)]));
  const start: Vec = [center[0] + d[0] * -radius, center[1] + d[1] * -radius];
  const out: Vec[] = [];
  const step = 1 / START_CAP_SEGMENTS;
  for (let t = step; t <= 1; t += step) out.push(rotAround(start, center, FIXED_PI * 2 * t));
  return out;
}

function roundStartCap(center: Vec, right: Vec): Vec[] {
  const out: Vec[] = [];
  const step = 1 / START_CAP_SEGMENTS;
  for (let t = step; t <= 1; t += step) out.push(rotAround(right, center, FIXED_PI * t));
  return out;
}

function flatStartCap(center: Vec, left: Vec, right: Vec): Vec[] {
  const cx = left[0] - right[0];
  const cy = left[1] - right[1];
  return [
    [center[0] - cx * 0.5, center[1] - cy * 0.5],
    [center[0] - cx * 0.51, center[1] - cy * 0.51],
    [center[0] + cx * 0.51, center[1] + cy * 0.51],
    [center[0] + cx * 0.5, center[1] + cy * 0.5],
  ];
}

function roundEndCap(center: Vec, direction: Vec, radius: number): Vec[] {
  const out: Vec[] = [];
  const start: Vec = [center[0] + direction[0] * radius, center[1] + direction[1] * radius];
  const step = 1 / END_CAP_SEGMENTS;
  for (let t = step; t < 1; t += step) out.push(rotAround(start, center, FIXED_PI * 3 * t));
  return out;
}

function flatEndCap(center: Vec, direction: Vec, radius: number): Vec[] {
  return [
    [center[0] + direction[0] * radius, center[1] + direction[1] * radius],
    [center[0] + direction[0] * (radius * 0.99), center[1] + direction[1] * (radius * 0.99)],
    [center[0] - direction[0] * (radius * 0.99), center[1] - direction[1] * (radius * 0.99)],
    [center[0] - direction[0] * radius, center[1] - direction[1] * radius],
  ];
}
