/**
 * Simulated pen input for testing and measuring the predictor (not used by
 * the app). Paths are in screen pixels at zoom 1, sampled at 240 Hz.
 */
import { PREDICTION_MS, predictPen, type InkSample } from "./predict";

export type PenPath = (t: number) => { x: number; y: number } | null;

export const SAMPLE_MS = 1000 / 240;

/** Samples of a path until it returns null or `duration` ms, with optional jitter (pixels). */
export function samplePath(path: PenPath, duration: number, jitter = 0, seed = 1): InkSample[] {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const out: InkSample[] = [];
  for (let t = 0; t <= duration; t += SAMPLE_MS) {
    const p = path(t);
    if (!p) break;
    out.push({ x: p.x + rand() * jitter, y: p.y + rand() * jitter, t });
  }
  return out;
}

export interface PredictionStats {
  /** Mean distance to where the pen is PREDICTION_MS later: without and with prediction. */
  meanErrorWithout: number;
  meanErrorWith: number;
  /** Largest distance from the predicted tip to anywhere the pen actually goes in the next 40 ms. */
  maxOffPath: number;
  /** Largest jump of the predicted tip between samples, beyond the pen's own movement. */
  maxJump: number;
  /** Longest prediction drawn, in pixels. */
  maxLength: number;
  /** Most consecutive samples with the tip more than 2 px off the path. */
  longestSpur: number;
}

/** Runs the predictor after every sample, as the engine does, and measures it against the true path. */
export function measure(path: PenPath, duration: number, jitter = 0): PredictionStats {
  const samples = samplePath(path, duration, jitter);
  let errWithout = 0;
  let errWith = 0;
  let counted = 0;
  let maxOffPath = 0;
  let maxJump = 0;
  let maxLength = 0;
  let spur = 0;
  let longestSpur = 0;
  let prevTip: { x: number; y: number } | null = null;
  let prevLatest: InkSample | null = null;
  for (let k = 1; k <= samples.length; k++) {
    const seen = samples.slice(0, k);
    const latest = seen[k - 1]!;
    const pred = predictPen(seen, 1, latest.t);
    const tip = pred.length ? pred[pred.length - 1]! : latest;
    maxLength = Math.max(maxLength, Math.hypot(tip.x - latest.x, tip.y - latest.y));
    const future = path(latest.t + PREDICTION_MS) ?? lastPoint(path, latest.t);
    errWithout += Math.hypot(future.x - latest.x, future.y - latest.y);
    errWith += Math.hypot(future.x - tip.x, future.y - tip.y);
    counted++;
    // Off the path: distance to the true path over the next 40 ms (or until it ends).
    let best = Infinity;
    for (let t = latest.t; t <= latest.t + 40; t += 0.25) {
      const q = path(t);
      if (!q) break;
      best = Math.min(best, Math.hypot(q.x - tip.x, q.y - tip.y));
    }
    if (best !== Infinity) maxOffPath = Math.max(maxOffPath, best);
    spur = best !== Infinity && best > 2 ? spur + 1 : 0;
    longestSpur = Math.max(longestSpur, spur);
    if (prevTip && prevLatest) {
      const moved = Math.hypot(latest.x - prevLatest.x, latest.y - prevLatest.y);
      maxJump = Math.max(maxJump, Math.hypot(tip.x - prevTip.x, tip.y - prevTip.y) - moved);
    }
    prevTip = tip;
    prevLatest = latest;
  }
  return { meanErrorWithout: errWithout / counted, meanErrorWith: errWith / counted, maxOffPath, maxJump, maxLength, longestSpur };
}

function lastPoint(path: PenPath, from: number): { x: number; y: number } {
  let last = path(from)!;
  for (let t = from; t < from + 1000; t += 0.25) {
    const q = path(t);
    if (!q) break;
    last = q;
  }
  return last;
}

/** Test paths. Speeds are in pixels per millisecond (0.6 = 600 px/s, brisk handwriting). */
export const PATHS: Record<string, { path: PenPath; duration: number }> = {
  "straight line, 600 px/s": { path: (t) => ({ x: t * 0.6, y: 0 }), duration: 400 },
  "circle, 500 px/s": { path: (t) => ({ x: 60 * Math.cos((t * 0.5) / 60), y: 60 * Math.sin((t * 0.5) / 60) }), duration: 800 },
  "handwriting loops": { path: (t) => ({ x: t * 0.25 + 25 * Math.cos(t / 40), y: 35 * Math.sin(t / 26) }), duration: 1200 },
  "90° corner": { path: (t) => (t < 200 ? { x: t * 0.6, y: 0 } : { x: 120, y: (t - 200) * 0.6 }), duration: 400 },
  "reversal (180°)": { path: (t) => ({ x: t < 200 ? t * 0.6 : 120 - (t - 200) * 0.6, y: 0 }), duration: 400 },
  "sudden stop": { path: (t) => ({ x: Math.min(t, 200) * 0.8, y: 0 }), duration: 400 },
  "start from rest": { path: (t) => ({ x: 0.0015 * t * t, y: 0.0005 * t * t }), duration: 400 },
  "corner, slowing into it": {
    // People slow down into sharp corners: speed falls to almost nothing at the turn.
    path: (t) => {
      const ease = (u: number) => u * u * (3 - 2 * u);
      if (t < 250) return { x: 120 * ease(t / 250), y: 0 };
      if (t < 500) return { x: 120, y: 120 * ease((t - 250) / 250) };
      return null;
    },
    duration: 500,
  },
  "very fast flick, 4000 px/s": { path: (t) => ({ x: t * 4, y: t * 0.5 }), duration: 150 },
};
