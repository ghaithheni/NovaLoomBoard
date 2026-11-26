import { describe, expect, it } from "vitest";
import { strokeOutline } from "./ink";
import { LiveOutline } from "./liveInk";
import type { InkTool } from "./model";

/** Small seeded generator so failures can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "smooth" | "jagged" | "slow" | "repeats" | "constant-pressure";

/** Input points (x, y, pressure) the way the engine records them. */
function makeStroke(kind: Kind, n: number, rand: () => number): number[] {
  const pts: number[] = [];
  let x = rand() * 200;
  let y = rand() * 200;
  let a = rand() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    let step = 0.4 + rand() * 3;
    if (kind === "smooth") a += (rand() - 0.5) * 0.3;
    else if (kind === "jagged") a += rand() < 0.15 ? Math.PI * (0.6 + rand() * 0.8) : (rand() - 0.5) * 0.5;
    else if (kind === "slow") {
      step = rand() * 0.3;
      a += (rand() - 0.5) * 2;
    } else a += (rand() - 0.5) * 0.6;
    if (kind === "repeats" && rand() < 0.3) step = 0;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    const p = kind === "constant-pressure" ? 0.5 : Math.min(1, Math.max(0, 0.5 + Math.sin(i / 9) * 0.4 + (rand() - 0.5) * 0.1));
    pts.push(x, y, p);
  }
  return pts;
}

const TOOLS: InkTool[] = ["pen", "pencil", "highlighter"];
const KINDS: Kind[] = ["smooth", "jagged", "slow", "repeats", "constant-pressure"];

describe("live stroke outline", () => {
  it("matches the full outline after every new point, for every tool, size and kind of stroke", () => {
    const rand = rng(20261126);
    let checks = 0;
    for (const tool of TOOLS) {
      for (const kind of KINDS) {
        for (const size of [1, 4, 12, 40]) {
          for (const simulate of [false, true]) {
            const source = makeStroke(kind, 160, rand);
            const live = new LiveOutline();
            const points: number[] = [];
            let i = 0;
            while (i < source.length / 3) {
              const chunk = 1 + Math.floor(rand() * 5);
              for (let k = 0; k < chunk && i < source.length / 3; k++, i++) points.push(source[i * 3]!, source[i * 3 + 1]!, source[i * 3 + 2]!);
              live.update(points, tool, size, simulate);
              const expected = strokeOutline(points, tool, size, simulate, false);
              const actual = live.outline();
              if (actual.length !== expected.length || actual.some((p, j) => p[0] !== expected[j]![0] || p[1] !== expected[j]![1])) {
                expect({ tool, kind, size, simulate, points: points.length / 3, actual }).toEqual({ tool, kind, size, simulate, points: points.length / 3, actual: expected });
              }
              checks++;
            }
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(5000);
  });

  it("settles most of a long stroke, so only a short tail is recomputed", () => {
    const rand = rng(7);
    const points = makeStroke("smooth", 2000, rand);
    const live = new LiveOutline();
    live.update(points, "pen", 4, false);
    expect(live.settledCount).toBeGreaterThan(1980);
  });

  it("starts over when the points are replaced, shrink, or the tool or size changes", () => {
    const rand = rng(3);
    const a = makeStroke("smooth", 300, rand);
    const live = new LiveOutline();
    live.update(a, "pen", 4, false);
    const shorter = a.slice(0, 150);
    live.update(shorter, "pen", 4, false);
    expect(live.outline()).toEqual(strokeOutline(shorter, "pen", 4, false, false));
    live.update(shorter, "pencil", 4, false);
    expect(live.outline()).toEqual(strokeOutline(shorter, "pencil", 4, false, false));
    live.update(shorter, "pencil", 9, true);
    expect(live.outline()).toEqual(strokeOutline(shorter, "pencil", 9, true, false));
    // The same array, cut down in place (the engine replaces it, but be safe).
    const same = a.slice();
    live.update(same, "pen", 4, false);
    same.length = 90;
    live.update(same, "pen", 4, false);
    expect(live.outline()).toEqual(strokeOutline(same, "pen", 4, false, false));
  });

  it("matches for one and two points, and a point repeated", () => {
    for (const pts of [[5, 5, 0.5], [5, 5, 0.5, 9, 7, 0.6], [5, 5, 0.5, 5, 5, 0.5, 5, 5, 0.5]]) {
      for (const tool of TOOLS) {
        const live = new LiveOutline();
        live.update(pts, tool, 6, true);
        expect(live.outline()).toEqual(strokeOutline(pts, tool, 6, true, false));
      }
    }
  });

  it("pieces and the tail together cover the settled outline", () => {
    const rand = rng(11);
    const points = makeStroke("jagged", 600, rand);
    const live = new LiveOutline();
    live.update(points, "pen", 6, false);
    const n = live.settledCount;
    // A piece's left side runs along the outline's left side, in order.
    const full = live.outline();
    const piece = live.piece(100, 300);
    const { left: l100 } = live.verticesAt(100);
    const { left: l300 } = live.verticesAt(300);
    expect(piece.slice(0, l300 - l100 + 1)).toEqual(full.slice(l100 - 1, l300));
    // The tail from the last settled point ends with the full outline's end cap and right side.
    const tail = live.tail(n - 1);
    expect(tail.length).toBeLessThan(full.length / 4);
    expect(live.lengthAt(n - 1)).toBeGreaterThan(live.lengthAt(0));
  });
});
