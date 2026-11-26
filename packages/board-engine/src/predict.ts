/**
 * Pen prediction for the stroke being drawn.
 *
 * Ink always trails the pen a little: input takes time to arrive and a frame
 * takes time to show. Drawing a short stretch of where the pen is heading
 * hides part of that delay. The predicted points are only ever drawn; they
 * are never added to the stroke, so the saved stroke is exactly the real
 * input.
 *
 * The prediction is deliberately cautious. It extrapolates at constant
 * velocity (no acceleration term, which is what overshoots at turns and
 * stops), from a velocity fitted over the last few samples. It fades out
 * smoothly when the pen is slow, turning, slowing down sharply, has only
 * just started, or has stopped sending input, and it never reaches further
 * than a fixed number of screen pixels.
 */

/** One input sample: world coordinates and the event time in milliseconds. */
export interface InkSample {
  x: number;
  y: number;
  t: number;
}

/** How far ahead to predict, in milliseconds. */
export const PREDICTION_MS = 8;
/** Samples older than this (relative to the newest) are not used. */
export const SAMPLE_WINDOW_MS = 32;
/** The longest prediction, in screen pixels. */
export const MAX_PREDICTION_PX = 20;
/** Fewest samples in the window before predicting. */
const MIN_SAMPLES = 4;
/** Shortest time span the window must cover. */
const MIN_SPAN_MS = 8;
/** Turning between the older and newer half of the window: full prediction up to 10°, none from 35°. */
const COS_STRAIGHT = Math.cos((10 * Math.PI) / 180);
const COS_TURNING = Math.cos((35 * Math.PI) / 180);
/** Slowing down: none when the newer part is at 60% of the older part's speed, full from 95%. */
const SLOWING = 0.6;
const STEADY = 0.95;
/** The newest stretch of input, checked against the fit to notice a stop at once. */
const RECENT_MS = 8;
/** With no new input, the prediction stays this long, then fades over FADE_MS. */
const HOLD_MS = 8;
const FADE_MS = 24;
/** Predictions shorter than this (screen pixels) are not drawn. */
const MIN_PX = 0.5;

/** 0 at or below `a`, 1 at or above `b`, smooth in between. */
function ramp(v: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Least-squares velocity (world units per ms) of samples[from..to). */
function fitVelocity(samples: readonly InkSample[], from: number, to: number): { vx: number; vy: number } | null {
  const n = to - from;
  if (n < 2) return null;
  let st = 0;
  let sx = 0;
  let sy = 0;
  for (let i = from; i < to; i++) {
    st += samples[i]!.t;
    sx += samples[i]!.x;
    sy += samples[i]!.y;
  }
  const mt = st / n;
  const mx = sx / n;
  const my = sy / n;
  let vtt = 0;
  let vtx = 0;
  let vty = 0;
  for (let i = from; i < to; i++) {
    const dt = samples[i]!.t - mt;
    vtt += dt * dt;
    vtx += dt * (samples[i]!.x - mx);
    vty += dt * (samples[i]!.y - my);
  }
  if (vtt <= 1e-9) return null;
  return { vx: vtx / vtt, vy: vty / vtt };
}

/**
 * Where the pen is predicted to go, as world points after the newest sample
 * (empty when there is no confident prediction). `zoom` converts to screen
 * pixels; `now` is the current time on the same clock as the samples.
 */
export function predictPen(samples: readonly InkSample[], zoom: number, now: number): { x: number; y: number }[] {
  const n = samples.length;
  if (n < MIN_SAMPLES || zoom <= 0) return [];
  const latest = samples[n - 1]!;
  let from = n - 1;
  while (from > 0 && latest.t - samples[from - 1]!.t <= SAMPLE_WINDOW_MS) from--;
  const count = n - from;
  if (count < MIN_SAMPLES || latest.t - samples[from]!.t < MIN_SPAN_MS) return [];

  const v = fitVelocity(samples, from, n);
  if (!v) return [];
  const sv = Math.hypot(v.vx, v.vy);
  if (sv <= 1e-9) return [];
  // Fade in as the stroke (or the movement after a pause) gets going.
  let confidence = ramp(latest.t - samples[from]!.t, MIN_SPAN_MS, SAMPLE_WINDOW_MS * 0.75);

  // Compare the older and newer half of the window: turning or braking means the line is about to end.
  const mid = from + Math.floor(count / 2);
  const older = fitVelocity(samples, from, mid + 1);
  const newer = fitVelocity(samples, mid, n);
  if (!older || !newer) return [];
  const so = Math.hypot(older.vx, older.vy);
  const sn = Math.hypot(newer.vx, newer.vy);
  if (so <= 1e-9 || sn <= 1e-9) return [];
  const cos = (older.vx * newer.vx + older.vy * newer.vy) / (so * sn);
  confidence *= ramp(cos, COS_TURNING, COS_STRAIGHT);
  confidence *= ramp(sn / so, SLOWING, STEADY);

  // The newest few milliseconds: a stop shows here first.
  let r = n - 2;
  while (r > from && latest.t - samples[r]!.t < RECENT_MS) r--;
  const rdt = latest.t - samples[r]!.t;
  if (rdt <= 0) return [];
  const rvx = (latest.x - samples[r]!.x) / rdt;
  const rvy = (latest.y - samples[r]!.y) / rdt;
  const sr = Math.hypot(rvx, rvy);
  if (sr <= 1e-9) return [];
  confidence *= ramp(sr / sv, SLOWING, STEADY);

  // No new input: the pen has probably stopped.
  confidence *= 1 - ramp(now - latest.t, HOLD_MS, HOLD_MS + FADE_MS);
  if (confidence <= 0) return [];

  // Direction from the fit; speed from the newest stretch when it is slower (the fit lags when braking).
  const k = (Math.min(sv, sr) / sv) * PREDICTION_MS * confidence;
  let dx = v.vx * k;
  let dy = v.vy * k;
  const px = Math.hypot(dx, dy) * zoom;
  if (px < MIN_PX) return [];
  if (px > MAX_PREDICTION_PX) {
    dx *= MAX_PREDICTION_PX / px;
    dy *= MAX_PREDICTION_PX / px;
  }
  return [
    { x: latest.x + dx / 2, y: latest.y + dy / 2 },
    { x: latest.x + dx, y: latest.y + dy },
  ];
}

/** Predicted points as stroke input (x, y, pressure), carrying the last real pressure. */
export function predictedInk(samples: readonly InkSample[], pressure: number, zoom: number, now: number): number[] {
  const out: number[] = [];
  for (const p of predictPen(samples, zoom, now)) out.push(p.x, p.y, pressure);
  return out;
}

/** Keeps only the samples the predictor can use (the window, plus a margin). */
export function trimSamples(samples: InkSample[]): void {
  const n = samples.length;
  if (n < 64) return;
  const latest = samples[n - 1]!.t;
  let drop = 0;
  while (drop < n - MIN_SAMPLES && latest - samples[drop]!.t > SAMPLE_WINDOW_MS * 2) drop++;
  if (drop > 0) samples.splice(0, drop);
}
