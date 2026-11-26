import { describe, expect, it } from "vitest";
import { strokeOutline } from "./ink";
import { LiveOutline } from "./liveInk";
import { MAX_PREDICTION_PX, PREDICTION_MS, predictedInk, predictPen, trimSamples, type InkSample } from "./predict";
import { measure, PATHS, samplePath, SAMPLE_MS } from "./predictSim";

const run = (name: string, jitter = 0) => measure(PATHS[name]!.path, PATHS[name]!.duration, jitter);
const line = (n: number, speed = 0.6, zoom = 1): InkSample[] => Array.from({ length: n }, (_, i) => ({ x: (i * SAMPLE_MS * speed) / zoom, y: 0, t: i * SAMPLE_MS }));

describe("pen prediction", () => {
  it("predicts nothing for the first few samples of a stroke", () => {
    for (let n = 0; n < 4; n++) expect(predictPen(line(n), 1, n * SAMPLE_MS)).toEqual([]);
  });

  it("fades in rather than appearing at full length", () => {
    const lengths = [];
    for (let n = 4; n <= 12; n++) {
      const s = line(n);
      const p = predictPen(s, 1, s[n - 1]!.t);
      lengths.push(p.length ? p[1]!.x - s[n - 1]!.x : 0);
    }
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]! - lengths[i - 1]!).toBeLessThan(2.5);
    expect(lengths[lengths.length - 1]).toBeCloseTo(0.6 * PREDICTION_MS, 1);
  });

  it("on a steady line, points to where the pen will be", () => {
    const m = run("straight line, 600 px/s");
    expect(m.meanErrorWith).toBeLessThan(m.meanErrorWithout * 0.1);
    expect(m.maxOffPath).toBeLessThan(0.1);
  });

  it("follows curves and handwriting closely, and never wobbles off the path", () => {
    for (const jitter of [0, 0.5]) {
      const circle = run("circle, 500 px/s", jitter);
      expect(circle.meanErrorWith).toBeLessThan(circle.meanErrorWithout * 0.3);
      expect(circle.maxOffPath).toBeLessThan(1.5);
      const loops = run("handwriting loops", jitter);
      expect(loops.meanErrorWith).toBeLessThan(loops.meanErrorWithout * 0.7);
      expect(loops.maxOffPath).toBeLessThan(4);
      const noisy = run("straight line, 600 px/s", jitter);
      expect(noisy.maxOffPath).toBeLessThan(1);
      expect(noisy.maxJump).toBeLessThan(3);
    }
  });

  it("does not shoot past a corner the pen slows into", () => {
    for (const jitter of [0, 0.5]) {
      const m = run("corner, slowing into it", jitter);
      expect(m.maxOffPath).toBeLessThan(1);
      expect(m.longestSpur).toBe(0);
    }
  });

  it("after an instant turn or stop, overshoots for at most a couple of samples and never beyond its horizon", () => {
    for (const name of ["90° corner", "reversal (180°)", "sudden stop"]) {
      const m = run(name, 0.5);
      expect(m.longestSpur).toBeLessThanOrEqual(Math.ceil(PREDICTION_MS / SAMPLE_MS));
      // At most how far the pen itself moves in PREDICTION_MS (0.8 px/ms for the stop), plus jitter.
      expect(m.maxOffPath).toBeLessThan(0.8 * PREDICTION_MS + 1);
    }
  });

  it("drops the prediction once the pen holds still", () => {
    const s = line(20);
    const stop = s[19]!;
    for (let i = 1; i <= 3; i++) s.push({ x: stop.x, y: stop.y, t: stop.t + i * SAMPLE_MS });
    expect(predictPen(s, 1, s[s.length - 1]!.t)).toEqual([]);
  });

  it("fades out when input stops arriving, without a sudden jump", () => {
    const s = line(20);
    const last = s[19]!.t;
    const len = (age: number) => {
      const p = predictPen(s, 1, last + age);
      return p.length ? p[1]!.x - s[19]!.x : 0;
    };
    expect(len(0)).toBeCloseTo(0.6 * PREDICTION_MS, 1);
    expect(len(8)).toBeCloseTo(0.6 * PREDICTION_MS, 1);
    expect(len(20)).toBeGreaterThan(0);
    expect(len(20)).toBeLessThan(len(8));
    expect(len(33)).toBe(0);
    for (let a = 0; a < 40; a += 1) expect(Math.abs(len(a + 1) - len(a))).toBeLessThan(0.6);
  });

  it("is limited to a fixed distance on screen, at any zoom", () => {
    for (const zoom of [0.25, 1, 4]) {
      const s = line(30, 4, zoom);
      const p = predictPen(s, zoom, s[29]!.t);
      const px = (p[1]!.x - s[29]!.x) * zoom;
      expect(px).toBeLessThanOrEqual(MAX_PREDICTION_PX + 1e-9);
      expect(px).toBeGreaterThan(MAX_PREDICTION_PX * 0.9);
    }
  });

  it("does nothing for slow movement, and starts from the newest sample", () => {
    const slow = line(30, 0.02);
    expect(predictPen(slow, 1, slow[29]!.t)).toEqual([]);
    const s = samplePath(PATHS["circle, 500 px/s"]!.path, 300);
    const p = predictPen(s, 1, s[s.length - 1]!.t);
    const latest = s[s.length - 1]!;
    // The first predicted point lies between the newest sample and the last one.
    expect(Math.hypot(p[0]!.x - latest.x, p[0]!.y - latest.y)).toBeCloseTo(Math.hypot(p[1]!.x - latest.x, p[1]!.y - latest.y) / 2, 6);
  });

  it("carries the last real pressure, and keeps a bounded number of samples", () => {
    const s = line(30);
    const ink = predictedInk(s, 0.73, 1, s[29]!.t);
    expect(ink.length).toBe(6);
    expect(ink[2]).toBe(0.73);
    expect(ink[5]).toBe(0.73);
    const many = line(500);
    trimSamples(many);
    expect(many.length).toBeLessThan(40);
    expect(predictPen(many, 1, many[many.length - 1]!.t)).toEqual(predictPen(line(500), 1, 499 * SAMPLE_MS));
  });
});

describe("predicted points in the live outline", () => {
  function stroke(n: number, seed: number): number[] {
    let s = seed;
    const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const pts: number[] = [];
    let x = 0;
    let y = 0;
    let a = 0;
    for (let i = 0; i < n; i++) {
      a += (rand() - 0.5) * (rand() < 0.05 ? 4 : 0.4);
      x += Math.cos(a) * (0.5 + rand() * 2);
      y += Math.sin(a) * (0.5 + rand() * 2);
      pts.push(x, y, 0.3 + rand() * 0.5);
    }
    return pts;
  }

  it("extend only the tail: the outline is exactly that of the real points plus the predicted ones", () => {
    for (const tool of ["pen", "pencil", "highlighter"] as const) {
      for (const simulate of [false, true]) {
        const src = stroke(200, tool.length * 7 + (simulate ? 1 : 0));
        const withPrediction = new LiveOutline();
        const without = new LiveOutline();
        const pts: number[] = [];
        for (let i = 0; i < 200; i++) {
          pts.push(src[i * 3]!, src[i * 3 + 1]!, src[i * 3 + 2]!);
          const x = src[i * 3]!;
          const y = src[i * 3 + 1]!;
          // A prediction that changes every frame, sometimes empty.
          const predicted = i % 5 === 4 ? [] : [x + 1 + (i % 3), y + 0.5, src[i * 3 + 2]!, x + 3 + (i % 4), y + 1.5, src[i * 3 + 2]!];
          withPrediction.update(pts, tool, 5, simulate, predicted);
          without.update(pts, tool, 5, simulate);
          if (pts.length >= 9) expect(withPrediction.outline()).toEqual(strokeOutline(pts.concat(predicted), tool, 5, simulate, false));
          // The settled part never depends on the prediction.
          expect(withPrediction.settledCount).toBe(without.settledCount);
        }
        // Once the prediction is gone, the outline is exactly the real stroke's.
        withPrediction.update(pts, tool, 5, simulate, []);
        expect(withPrediction.outline()).toEqual(strokeOutline(pts, tool, 5, simulate, false));
      }
    }
  });

  it("are ignored while the stroke has fewer than three real points", () => {
    const live = new LiveOutline();
    const pts = [0, 0, 0.5, 2, 1, 0.5];
    live.update(pts, "pen", 4, false, [5, 2, 0.5]);
    expect(live.outline()).toEqual(strokeOutline(pts, "pen", 4, false, false));
  });
});
