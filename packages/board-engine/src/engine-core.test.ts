import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fitBounds, screenToWorld, worldToScreen, zoomAt, MAX_ZOOM, MIN_ZOOM } from "./camera";
import { densify, distToSegmentSq, erasePolyline, pointsBounds, polylineHitsSegment, segmentDistanceSq } from "./geometry";
import { History } from "./history";
import { needsSimulatedPressure, outlineToSvgPath, strokeOutline } from "./ink";
import { createPage, type StrokeObject } from "./model";
import { applyOps, invertBatch, type Batch } from "./ops";

function stroke(id: string, points: number[] = [0, 0, 0.5, 10, 10, 0.5]): StrokeObject {
  return {
    id,
    type: "stroke",
    tool: "pen",
    style: { color: "#000", size: 4, opacity: 1 },
    points,
    simulatePressure: true,
    bounds: pointsBounds(points, 4),
  };
}

describe("geometry", () => {
  it("measures point-to-segment distance", () => {
    expect(distToSegmentSq(5, 5, 0, 0, 10, 0)).toBeCloseTo(25);
    expect(distToSegmentSq(-3, 4, 0, 0, 10, 0)).toBeCloseTo(25);
    expect(distToSegmentSq(3, 3, 3, 3, 3, 3)).toBe(0);
  });

  it("detects crossing segments as zero distance", () => {
    expect(segmentDistanceSq(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0);
    expect(segmentDistanceSq(0, 0, 10, 0, 0, 5, 10, 5)).toBeCloseTo(25);
  });

  it("densifies long segments without moving endpoints", () => {
    const d = densify([0, 0, 0.2, 10, 0, 0.8], 2);
    expect(d.length / 3).toBe(6);
    expect(d.slice(0, 3)).toEqual([0, 0, 0.2]);
    expect(d.slice(-3)).toEqual([10, 0, 0.8]);
    expect(d[7]).toBeCloseTo(0); // y stays on the line
  });

  it("hit-tests a polyline against an eraser segment", () => {
    const pts = [0, 0, 0.5, 100, 0, 0.5];
    expect(polylineHitsSegment(pts, 50, 5, 50, 5, 6)).toBe(true);
    expect(polylineHitsSegment(pts, 50, 20, 50, 20, 6)).toBe(false);
    // Eraser path crossing between two sparse points still hits.
    expect(polylineHitsSegment(pts, 50, -30, 50, 30, 1)).toBe(true);
  });

  it("splits a stroke where the eraser passes through", () => {
    const runs = erasePolyline([0, 0, 0.5, 100, 0, 0.5], 50, -10, 50, 10, 5);
    expect(runs).not.toBeNull();
    expect(runs!.length).toBe(2);
    const [left, right] = runs!;
    expect(Math.max(...left!.filter((_, i) => i % 3 === 0))).toBeLessThan(45.01);
    expect(Math.min(...right!.filter((_, i) => i % 3 === 0))).toBeGreaterThan(54.99);
  });

  it("returns null when the eraser misses, and no runs when everything is erased", () => {
    expect(erasePolyline([0, 0, 0.5, 100, 0, 0.5], 50, 40, 50, 40, 5)).toBeNull();
    expect(erasePolyline([0, 0, 0.5, 4, 0, 0.5], 2, 0, 2, 0, 10)).toEqual([]);
  });
});

describe("camera", () => {
  it("round-trips screen and world coordinates", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: MIN_ZOOM, max: MAX_ZOOM, noNaN: true }),
        fc.double({ min: -1e3, max: 1e3, noNaN: true }),
        fc.double({ min: -1e3, max: 1e3, noNaN: true }),
        (cx, cy, zoom, sx, sy) => {
          const cam = { x: cx, y: cy, zoom };
          const w = screenToWorld(cam, sx, sy);
          const s = worldToScreen(cam, w.x, w.y);
          expect(s.x).toBeCloseTo(sx, 6);
          expect(s.y).toBeCloseTo(sy, 6);
        },
      ),
    );
  });

  it("keeps the anchor point fixed while zooming and clamps zoom", () => {
    const cam = { x: 100, y: -50, zoom: 1.5 };
    const before = screenToWorld(cam, 300, 200);
    const next = zoomAt(cam, 300, 200, 2);
    const after = screenToWorld(next, 300, 200);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAt(cam, 0, 0, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, 0, 0, 1e-6).zoom).toBe(MIN_ZOOM);
  });

  it("fits content inside the viewport", () => {
    const cam = fitBounds({ minX: 0, minY: 0, maxX: 2000, maxY: 1000 }, 1000, 800, 50)!;
    const tl = worldToScreen(cam, 0, 0);
    const br = worldToScreen(cam, 2000, 1000);
    expect(tl.x).toBeGreaterThanOrEqual(49.9);
    expect(br.x).toBeLessThanOrEqual(950.1);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.y).toBeLessThanOrEqual(800);
  });
});

describe("operations and history", () => {
  it("applies and inverts adds and removes with exact z-order", () => {
    const page = createPage();
    const a = stroke("a");
    const b = stroke("b");
    const c = stroke("c");
    applyOps(page, [{ kind: "add", object: a }, { kind: "add", object: b }, { kind: "add", object: c }]);
    const batch = applyOps(page, [
      { kind: "remove", object: b },
      { kind: "add", object: stroke("b1"), index: 1 },
      { kind: "add", object: stroke("b2"), index: 2 },
    ]);
    expect(page.order).toEqual(["a", "b1", "b2", "c"]);
    applyOps(page, invertBatch(batch));
    expect(page.order).toEqual(["a", "b", "c"]);
    applyOps(page, batch);
    expect(page.order).toEqual(["a", "b1", "b2", "c"]);
  });

  it("skips invalid operations instead of corrupting state", () => {
    const page = createPage();
    const a = stroke("a");
    expect(applyOps(page, [{ kind: "remove", object: a }])).toEqual([]);
    applyOps(page, [{ kind: "add", object: a }]);
    expect(applyOps(page, [{ kind: "add", object: a }])).toEqual([]);
    expect(page.order).toEqual(["a"]);
  });

  it("undoing every random batch restores the original page (property)", () => {
    type Step = { type: "add"; at: number } | { type: "remove"; pick: number };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ type: fc.constant("add" as const), at: fc.nat(20) }),
      fc.record({ type: fc.constant("remove" as const), pick: fc.nat(20) }),
    );
    fc.assert(
      fc.property(fc.array(fc.array(step, { minLength: 1, maxLength: 5 }), { maxLength: 30 }), (batches) => {
        const page = createPage();
        applyOps(page, [{ kind: "add", object: stroke("seed0") }, { kind: "add", object: stroke("seed1") }]);
        const initial = [...page.order];
        const history = new History();
        let n = 0;
        for (const steps of batches) {
          const resolved: Batch = [];
          for (const s of steps) {
            if (s.type === "add") {
              resolved.push(...applyOps(page, [{ kind: "add", object: stroke(`o${n++}`), index: s.at }]));
            } else if (page.order.length) {
              const id = page.order[s.pick % page.order.length]!;
              resolved.push(...applyOps(page, [{ kind: "remove", object: page.objects.get(id)! }]));
            }
          }
          history.push(resolved);
        }
        let batch: Batch | undefined;
        while ((batch = history.undo())) applyOps(page, invertBatch(batch));
        expect(page.order).toEqual(initial);
        expect([...page.objects.keys()].sort()).toEqual([...initial].sort());
      }),
    );
  });

  it("clears redo after a new action", () => {
    const h = new History();
    const page = createPage();
    h.push(applyOps(page, [{ kind: "add", object: stroke("a") }]));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.push(applyOps(page, [{ kind: "add", object: stroke("b") }]));
    expect(h.canRedo).toBe(false);
    expect(h.canUndo).toBe(true);
  });
});

describe("ink", () => {
  it("produces a closed outline path for a stroke", () => {
    const outline = strokeOutline([0, 0, 0.5, 20, 5, 0.6, 40, 0, 0.7], "pen", 6, false, true);
    expect(outline.length).toBeGreaterThan(4);
    const d = outlineToSvgPath(outline);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("writes every curve's control point, so long strokes don't drift", () => {
    const points: number[] = [];
    for (let i = 0; i < 2000; i++) points.push(i * 1.37 + Math.sin(i / 7) * 9, Math.cos(i / 11) * 40, 0.5);
    const outline = strokeOutline(points, "pen", 3, false, true);
    const d = outlineToSvgPath(outline);
    expect(d).not.toContain("T");
    const curves = d.slice(1, -1).split("Q").slice(1);
    expect(curves.length).toBe(outline.length - 2);
    // Each control point is its outline vertex, to the 0.01 the path is written with.
    curves.forEach((c, i) => {
      const [cx, cy] = c.split(" ")[0]!.split(",").map(Number);
      expect(Math.abs(cx! - outline[i + 1]![0]!)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(cy! - outline[i + 1]![1]!)).toBeLessThanOrEqual(0.005 + 1e-9);
    });
  });

  it("decides when pressure must be simulated", () => {
    expect(needsSimulatedPressure("mouse", [0, 0, 0.5, 1, 1, 0.5])).toBe(true);
    expect(needsSimulatedPressure("pen", [0, 0, 0.3, 1, 1, 0.6])).toBe(false);
    expect(needsSimulatedPressure("pen", [0, 0, 0.5, 1, 1, 0.5, 2, 2, 0.5])).toBe(true);
  });
});
