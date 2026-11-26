import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StrokeObject } from "@novaloom/board-engine";
import { decodeObject, encodeObject, validateOps, ZOrderTracker, type PageRow, type StoredObject, type StoreOp } from "@novaloom/board-engine/persist";
import { applyOps, type Batch } from "../../board-engine/src/ops";
import { createPage } from "../../board-engine/src/model";
import { PageList } from "../../board-engine/src/pages";
import { BoardFile, BoardUnavailableError, isUnavailable, replayEntries, SCHEMA_VERSION, SequenceGapError } from "./board-file";
import { Journal, type SaveStatus } from "./journal";
import { Library } from "./library";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nlboard-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stroke(id: string, x = 0): StrokeObject {
  const points = [x, 0, 0.5, x + 10, 10, 0.5];
  return {
    id,
    type: "stroke",
    tool: "pen",
    style: { color: "#112233", size: 4, opacity: 1 },
    points,
    simulatePressure: true,
    bounds: { minX: x - 2, minY: -2, maxX: x + 12, maxY: 12 },
  };
}

const put = (id: string, z: number, x = 0, page = "p1"): StoreOp => ({ op: "put", page, object: encodeObject(stroke(id, x), z) });
const pageRow = (id: string, position: number, extra: Partial<PageRow> = {}): PageRow => ({
  id,
  position,
  name: "",
  background: "grid",
  view: null,
  ...extra,
});
const addPage = (id: string, position: number, extra: Partial<PageRow> = {}): StoreOp => ({ op: "putPage", page: pageRow(id, position, extra) });

describe("ZOrderTracker", () => {
  it("keeps the same order as the engine through inserts, removals and renumbering", () => {
    const page = createPage();
    const tracker = new ZOrderTracker("p1");
    const stored = new Map<string, number>();
    const run = (batch: Batch) => {
      for (const op of tracker.apply(batch)) {
        expect(op.op === "put" ? op.page : "p1").toBe("p1");
        if (op.op === "put") stored.set(op.object.id, op.object.z);
        else if (op.op === "delete") stored.delete(op.id);
        else if (op.op === "setZ") stored.set(op.id, op.z);
      }
    };
    run(applyOps(page, [{ kind: "add", object: stroke("a") }, { kind: "add", object: stroke("b") }]));
    // Repeated inserts at the same spot exhaust float precision and force renumbering.
    for (let i = 0; i < 80; i++) run(applyOps(page, [{ kind: "add", object: stroke(`m${i}`), index: 1 }]));
    run(applyOps(page, [{ kind: "remove", object: page.objects.get("m40")! }]));
    const byZ = [...stored.entries()].sort((p, q) => p[1] - q[1]).map(([id]) => id);
    expect(byZ).toEqual(page.order);
    expect(new Set(stored.values()).size).toBe(stored.size);
  });
});

describe("object encoding", () => {
  it("round-trips a stroke (Float32 precision)", () => {
    const s = stroke("x", 1.25);
    const back = decodeObject(encodeObject(s, 3)) as StrokeObject;
    expect(back.points).toEqual(s.points);
    expect(back.style).toEqual(s.style);
  });

  it("rejects invalid objects", () => {
    const good = encodeObject(stroke("x"), 0);
    expect(() => decodeObject({ ...good, type: "blob" })).toThrow();
    expect(() => decodeObject({ ...good, data: "{" })).toThrow();
    expect(() => decodeObject({ ...good, points: new Uint8Array(7) })).toThrow();
    expect(() => decodeObject({ ...good, data: JSON.stringify({ tool: "pen", style: { color: "red" } }) })).toThrow();
  });
});

describe("BoardFile", () => {
  it("creates, commits and reopens", () => {
    const p = path.join(dir, "a.nlboard");
    const f = BoardFile.create(p, { boardId: "b1", title: "Maths" });
    f.commit([
      {
        seq: 1,
        ops: [put("s1", 0), put("s2", 1), { op: "updatePage", id: "p1", background: "dots", view: { x: 1, y: 2, zoom: 2 } }],
      },
    ]);
    f.commit([{ seq: 2, ops: [{ op: "delete", id: "s1" }] }]);
    f.close();
    const g = BoardFile.open(p);
    const meta = g.readMeta();
    expect(meta).toMatchObject({ boardId: "b1", title: "Maths", lastAppliedSeq: 2, activePage: "p1" });
    expect(meta.pages).toEqual([pageRow("p1", 0, { background: "dots", view: { x: 1, y: 2, zoom: 2 } })]);
    expect(g.readObjects().map((o) => o.id)).toEqual(["s2"]);
    expect(g.verify()).toEqual([]);
    g.close();
  });

  it("saves the new backgrounds and board colours, and validates them", () => {
    const p = path.join(dir, "a.nlboard");
    const f = BoardFile.create(p, { boardId: "b1", title: "t" });
    f.commit([{ seq: 1, ops: [{ op: "updatePage", id: "p1", background: "staff-green" }] }]);
    f.close();
    const g = BoardFile.open(p);
    expect(g.readMeta().pages[0]!.background).toBe("staff-green");
    g.close();
    expect(() => validateOps([{ op: "updatePage", id: "p1", background: "axes-black" }])).not.toThrow();
    expect(() => validateOps([{ op: "updatePage", id: "p1", background: "grid-purple" as never }])).toThrow();
  });

  it("skips duplicate sequence numbers and rejects gaps atomically", () => {
    const f = BoardFile.create(path.join(dir, "a.nlboard"), { boardId: "b1", title: "t" });
    f.commit([{ seq: 1, ops: [put("s1", 0)] }]);
    expect(f.commit([{ seq: 1, ops: [put("dup", 1)] }])).toEqual({ applied: 0, skipped: 1 });
    expect(() => f.commit([{ seq: 2, ops: [put("s2", 1)] }, { seq: 4, ops: [put("s4", 2)] }])).toThrow(SequenceGapError);
    expect(f.readObjects().map((o) => o.id)).toEqual(["s1"]);
    expect(f.readMeta().lastAppliedSeq).toBe(1);
    f.close();
  });

  it("rolls back a failed commit and keeps saving afterwards", () => {
    const f = BoardFile.create(path.join(dir, "a.nlboard"), { boardId: "b1", title: "t" });
    // The second op breaks the page foreign key: the whole entry must roll back.
    expect(() => f.commit([{ seq: 1, ops: [put("s1", 0), put("s2", 1, 0, "missing-page")] }])).toThrow();
    expect(f.readObjects()).toEqual([]);
    expect(f.commit([{ seq: 1, ops: [put("s1", 0)] }])).toEqual({ applied: 1, skipped: 0 });
    expect(f.readObjects().map((o) => o.id)).toEqual(["s1"]);
    f.close();
  });

  it("releases the file when closed, and closing twice is harmless", () => {
    const p = path.join(dir, "a.nlboard");
    const f = BoardFile.create(p, { boardId: "b1", title: "t" });
    f.commit([{ seq: 1, ops: [put("s1", 0)] }]);
    f.close();
    f.close();
    // On Windows an open SQLite handle makes rename fail with EBUSY.
    fs.renameSync(p, `${p}.moved`);
    fs.rmSync(`${p}.moved`);
  });

  it("writes objects without points that were read back from a file (empty point data stays a blob)", () => {
    const shape: StoredObject = encodeObject(
      { id: "r", type: "shape", kind: "rect", x1: 0, y1: 0, x2: 10, y2: 10, rotation: 0, style: { color: "#112233", size: 2, opacity: 1, fill: "none" }, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
      1,
    );
    const a = BoardFile.create(path.join(dir, "a.nlboard"), { boardId: "a", title: "t" });
    a.commit([{ seq: 1, ops: [put("s1", 0), { op: "put", page: "p1", object: shape }] }]);
    const read = a.readObjects();
    a.close();
    expect(read.find((o) => o.id === "r")!.points.byteLength).toBe(0);
    // Write what was read into another file, as importing a board does.
    const bPath = path.join(dir, "b.nlboard");
    const b = BoardFile.create(bPath, { boardId: "b", title: "t" });
    b.commit([{ seq: 1, ops: read.map(({ page, ...object }) => ({ op: "put" as const, page, object })) }]);
    expect(b.verify()).toEqual([]);
    b.close();
    const raw = new DatabaseSync(bPath, { readOnly: true });
    expect(raw.prepare("SELECT id, typeof(points) AS t, length(points) AS n FROM objects ORDER BY id").all()).toEqual([
      { id: "r", t: "blob", n: 0 },
      { id: "s1", t: "blob", n: 24 },
    ]);
    raw.close();
    // Point data must still be supplied.
    const c = BoardFile.create(path.join(dir, "c.nlboard"), { boardId: "c", title: "t" });
    const broken = { ...shape, id: "x", points: null } as unknown as StoredObject;
    expect(() => c.commit([{ seq: 1, ops: [{ op: "put", page: "p1", object: broken }] }])).toThrow(/no point data/);
    c.close();
  });

  it("keeps each page's objects, background, view and name, and the page order", () => {
    const f = BoardFile.create(path.join(dir, "a.nlboard"), { boardId: "b1", title: "t" });
    f.commit([
      {
        seq: 1,
        ops: [
          put("a1", 0),
          addPage("p2", 1, { name: "Diagrams", background: "dots", view: { x: 5, y: 6, zoom: 0.5 } }),
          put("b1", 0, 0, "p2"),
          put("b2", 1, 0, "p2"),
          addPage("p3", 2),
        ],
        props: { activePage: "p2" },
      },
    ]);
    // Move p3 to the front, rename p1.
    f.commit([
      {
        seq: 2,
        ops: [
          { op: "updatePage", id: "p3", position: 0 },
          { op: "updatePage", id: "p1", position: 1, name: "Intro" },
          { op: "updatePage", id: "p2", position: 2 },
        ],
      },
    ]);
    const meta = f.readMeta();
    expect(meta.pages.map((p) => [p.id, p.name, p.background])).toEqual([
      ["p3", "", "grid"],
      ["p1", "Intro", "grid"],
      ["p2", "Diagrams", "dots"],
    ]);
    expect(meta.pages[2]!.view).toEqual({ x: 5, y: 6, zoom: 0.5 });
    expect(meta.activePage).toBe("p2");
    expect(f.readObjects("p2").map((o) => o.id)).toEqual(["b1", "b2"]);
    expect(f.readObjects("p1").map((o) => o.id)).toEqual(["a1"]);
    expect(f.readObjects("p3")).toEqual([]);
    expect(f.verify()).toEqual([]);
    f.close();
  });

  it("deletes a page with its objects; re-putting a page keeps its objects", () => {
    const f = BoardFile.create(path.join(dir, "a.nlboard"), { boardId: "b1", title: "t" });
    f.commit([{ seq: 1, ops: [addPage("p2", 1), put("b1", 0, 0, "p2"), put("a1", 0)], props: { activePage: "p2" } }]);
    // putPage on an existing page is an update, never a delete-and-insert (which would cascade).
    f.commit([{ seq: 2, ops: [addPage("p1", 0, { name: "First" })] }]);
    expect(f.readObjects("p1").map((o) => o.id)).toEqual(["a1"]);
    f.commit([{ seq: 3, ops: [{ op: "deletePage", id: "p2" }] }]);
    const meta = f.readMeta();
    expect(meta.pages.map((p) => p.id)).toEqual(["p1"]);
    expect(meta.activePage).toBe("p1"); // falls back when the remembered page is gone
    expect(f.readObjects().map((o) => o.id)).toEqual(["a1"]);
    expect(f.verify()).toEqual([]);
    f.close();
  });

  it("rejects an object on a page that does not exist, writing nothing", () => {
    const f = BoardFile.create(path.join(dir, "a.nlboard"), { boardId: "b1", title: "t" });
    expect(() => f.commit([{ seq: 1, ops: [put("a1", 0), put("x", 1, 0, "nope")] }])).toThrow();
    expect(f.readObjects()).toEqual([]);
    expect(f.readMeta().lastAppliedSeq).toBe(0);
    f.close();
  });

  it("upgrades a version 1 (single-page) file, keeping its objects, background and view", () => {
    const p = path.join(dir, "old.nlboard");
    writeV1File(p);
    // A read-only open (snapshot checks) reads it without changing it.
    const ro = BoardFile.open(p, { readOnly: true });
    expect(ro.verify()).toEqual([]);
    expect(ro.readMeta().pages).toEqual([pageRow("p1", 0, { background: "ruled", view: { x: 10, y: 20, zoom: 1.5 } })]);
    ro.close();
    expect(userVersion(p)).toBe(1);

    const f = BoardFile.open(p);
    expect(userVersion(p)).toBe(SCHEMA_VERSION);
    const meta = f.readMeta();
    expect(meta).toMatchObject({ boardId: "old", title: "Old board", activePage: "p1", lastAppliedSeq: 3 });
    expect(meta.pages).toEqual([pageRow("p1", 0, { background: "ruled", view: { x: 10, y: 20, zoom: 1.5 } })]);
    expect(f.readObjects().map((o) => [o.id, o.page])).toEqual([["s1", "p1"]]);
    expect(f.verify()).toEqual([]);
    // Pages can be added to the upgraded file.
    f.commit([{ seq: 4, ops: [addPage("p2", 1), put("s2", 0, 0, "p2")] }]);
    expect(f.readMeta().pages.map((x) => x.id)).toEqual(["p1", "p2"]);
    f.close();
  });

  it("opens files from pre-release builds and gives them the current identifier when saved", () => {
    const p = path.join(dir, "prerelease.nlboard");
    const f = BoardFile.create(p, { boardId: "b1", title: "t" });
    f.commit([{ seq: 1, ops: [put("s1", 0)] }]);
    f.close();
    const appId = () => {
      const db = new DatabaseSync(p, { readOnly: true });
      const id = (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      db.close();
      return id;
    };
    const current = appId();
    const db = new DatabaseSync(p);
    db.exec("PRAGMA application_id = 1111769649"); // 0x42444231, written by pre-release builds
    db.close();
    // A read-only open reads it without changing it.
    const ro = BoardFile.open(p, { readOnly: true });
    expect(ro.readObjects().map((o) => o.id)).toEqual(["s1"]);
    ro.close();
    expect(appId()).toBe(1111769649);
    BoardFile.open(p).close();
    expect(appId()).toBe(current);
    // Any other identifier is still refused.
    const other = new DatabaseSync(p);
    other.exec("PRAGMA application_id = 7");
    other.close();
    expect(() => BoardFile.open(p)).toThrow(/not a NovaLoomBoard file/);
  });

  it("refuses files that are not boards", () => {
    const p = path.join(dir, "junk.nlboard");
    fs.writeFileSync(p, "hello, not sqlite at all".repeat(100));
    expect(() => BoardFile.open(p)).toThrow();
  });
});

describe("Journal", () => {
  function setup(commit: (n: number) => void) {
    const timers: { fn: () => void; at: number; id: number }[] = [];
    let now = 0;
    let nextId = 1;
    const statuses: SaveStatus[] = [];
    const committed: number[] = [];
    const j = new Journal({
      lastSeq: 5,
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms, id: nextId++ };
        timers.push(t);
        return t.id;
      },
      clearTimer: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i !== -1) timers.splice(i, 1);
      },
      commit: (entries) => {
        commit(entries.length);
        committed.push(...entries.map((e) => e.seq));
      },
      onStatus: (s) => statuses.push(s),
    });
    const advance = (ms: number) => {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > now) break;
        timers.shift();
        t.fn();
      }
    };
    return { j, advance, statuses, committed };
  }

  it("batches entries within the commit window with consecutive sequence numbers", () => {
    const sizes: number[] = [];
    const { j, advance, statuses, committed } = setup((n) => sizes.push(n));
    j.add([put("a", 0)]);
    advance(50);
    j.add([put("b", 1)]);
    expect(sizes).toEqual([]);
    advance(100);
    expect(sizes).toEqual([2]);
    expect(committed).toEqual([6, 7]);
    expect(statuses).toEqual(["saving", "saved"]);
  });

  it("keeps entries after a failed commit and retries", () => {
    let fail = true;
    const { j, advance, statuses, committed } = setup(() => {
      if (fail) throw new Error("SQLITE_FULL");
    });
    j.add([put("a", 0)]);
    advance(150);
    expect(statuses.at(-1)).toBe("error");
    expect(j.pending).toBe(1);
    j.add([put("b", 1)]);
    fail = false;
    advance(10_000);
    expect(committed).toEqual([6, 7]);
    expect(statuses.at(-1)).toBe("saved");
    expect(j.pending).toBe(0);
  });

  it("commits everything on an explicit flush after a failure", () => {
    let fail = true;
    const { j, advance, statuses } = setup(() => {
      if (fail) throw new Error("busy");
    });
    j.add([put("a", 0)]);
    advance(150);
    expect(statuses).toContain("error");
    fail = false;
    expect(j.flush()).toBe(true);
    expect(statuses.at(-1)).toBe("saved");
  });
});

describe("validateOps", () => {
  it("accepts page operations and rejects invalid ones", () => {
    const ok = validateOps([addPage("p2", 1, { name: "A" }), { op: "updatePage", id: "p2", name: "B" }, { op: "deletePage", id: "p2" }]);
    expect(ok).toHaveLength(3);
    expect(() => validateOps([{ op: "put", object: encodeObject(stroke("x"), 0) }])).toThrow(/page/);
    expect(() => validateOps([addPage("p2", 1, { background: "plaid" as never })])).toThrow();
    expect(() => validateOps([addPage("p2", Number.NaN)])).toThrow();
    expect(() => validateOps([{ op: "updatePage", id: "p2", name: "x".repeat(101) }])).toThrow();
    expect(() => validateOps([{ op: "updatePage", id: "p2", view: { x: 0, y: 0, zoom: -1 } }])).toThrow();
    expect(() => validateOps([{ op: "dropTable" }])).toThrow();
  });
});

describe("pages end to end", () => {
  it("page operations committed to a file reopen with the same pages, order, names and objects", () => {
    const p = path.join(dir, "a.nlboard");
    const f = BoardFile.create(p, { boardId: "b1", title: "t" });
    const meta = f.readMeta();
    const { list } = PageList.fromPayload(meta.pages.map((pg) => ({ ...pg, objects: [] })), meta.activePage);
    let seq = 0;
    const commit = (ops: StoreOp[], props?: { activePage?: string }) => f.commit([{ seq: ++seq, ops, props }]);

    const first = list.active;
    commit(first.tracker.apply([{ kind: "add", object: stroke("a1"), index: 0 }]));
    const two = list.add({ background: "dots", view: { x: 3, y: 4, zoom: 2 } });
    commit(two.ops);
    commit(two.page.tracker.apply([{ kind: "add", object: stroke("t1"), index: 0 }, { kind: "add", object: stroke("t2", 40), index: 1 }]));
    const copy = list.duplicate(two.page.id, [stroke("t1"), stroke("t2", 40)]);
    commit(copy.ops, { activePage: copy.page.id });
    commit(list.rename(copy.page.id, "Copy of two"));
    commit(list.move(0, 2)); // first page to the end
    const third = list.add({ background: "blank", view: null }, 0);
    commit(third.ops);
    const removed = list.remove(two.page.id);
    commit(removed.ops);
    f.close();

    const g = BoardFile.open(p);
    const back = g.readMeta();
    expect(g.verify()).toEqual([]);
    expect(back.pages.map((x) => x.id)).toEqual(list.all.map((x) => x.id));
    expect(back.pages.map((x) => [x.name, x.background])).toEqual([
      ["", "blank"],
      ["Copy of two", "dots"],
      ["", "grid"],
    ]);
    expect(back.pages[1]!.view).toEqual({ x: 3, y: 4, zoom: 2 });
    expect(back.activePage).toBe(copy.page.id);
    expect(g.readObjects(first.id).map((o) => o.id)).toEqual(["a1"]);
    expect(g.readObjects(copy.page.id).map((o) => o.id)).toEqual(copy.page.objects.map((o) => o.id));
    expect(g.readObjects(two.page.id)).toEqual([]); // deleted with its page
    g.close();
  });
});

describe("replayEntries", () => {
  it("computes the state after uncommitted entries, including page deletes", () => {
    const f = BoardFile.create(path.join(dir, "a.nlboard"), { boardId: "b1", title: "t" });
    f.commit([{ seq: 1, ops: [addPage("p2", 1), put("a1", 0), put("b1", 0, 0, "p2")] }]);
    const pending = [
      { seq: 2, ops: [addPage("p3", 2, { name: "New" }), put("c1", 0, 0, "p3"), { op: "updatePage", id: "p1", name: "One" } as StoreOp] },
      { seq: 3, ops: [{ op: "deletePage", id: "p2" } as StoreOp], props: { activePage: "p3", title: "Renamed" } },
    ];
    const replayed = replayEntries(f.readMeta(), f.readObjects(), pending);
    f.commit(pending);
    const real = { meta: f.readMeta(), objects: f.readObjects() };
    expect(replayed.meta.pages).toEqual(real.meta.pages);
    expect(replayed.meta).toMatchObject({ title: "Renamed", activePage: "p3" });
    expect(replayed.objects.map((o) => [o.id, o.page]).sort()).toEqual(real.objects.map((o) => [o.id, o.page]).sort());
    f.close();
  });
});

describe("Library", () => {
  it("detects an unclean exit and keeps committed changes", () => {
    const lib = new Library(dir);
    const id = lib.createBoard("Science");
    const a = lib.openBoard(id);
    expect(a.recovery).toBeUndefined();
    a.file.commit([{ seq: 1, ops: [put("s1", 0)] }]);
    // Simulate a crash: the file is never closed and the marker stays.
    const b = new Library(dir).openBoard(id);
    expect(b.recovery?.kind).toBe("unclean-exit");
    expect(b.objects.map((o) => o.id)).toEqual(["s1"]);
    lib.closeBoard(b);
    a.file.close();
    const c = lib.openBoard(id);
    expect(c.recovery).toBeUndefined();
    lib.closeBoard(c);
    expect(lib.lastBoardId).toBe(id);
    expect(lib.recent()[0]).toMatchObject({ id, title: "Science" });
  });

  it("quarantines a damaged file and restores the newest verified snapshot", () => {
    const lib = new Library(dir);
    const id = lib.createBoard();
    const a = lib.openBoard(id);
    a.file.commit([{ seq: 1, ops: [put("s1", 0)] }]);
    lib.snapshot(a, "auto");
    a.file.commit([{ seq: 2, ops: [put("s2", 1)] }]);
    lib.closeBoard(a);

    // Corrupt the file's pages (keep the header so it still looks like SQLite).
    const p = lib.boardPath(id);
    const bytes = fs.readFileSync(p);
    bytes.fill(0xab, 100);
    fs.writeFileSync(p, bytes);

    const b = lib.openBoard(id);
    expect(b.recovery?.kind).toBe("restored-snapshot");
    expect(b.objects.map((o) => o.id)).toEqual(["s1"]);
    expect(fs.readdirSync(lib.damagedDir).length).toBeGreaterThan(0);
    lib.closeBoard(b);
  });

  it("recovers every page after an unclean exit and from a snapshot", () => {
    const lib = new Library(dir);
    const id = lib.createBoard("Pages");
    const a = lib.openBoard(id);
    a.file.commit([
      { seq: 1, ops: [put("a1", 0), addPage("p2", 1, { name: "Two", background: "dots" }), put("b1", 0, 0, "p2")], props: { activePage: "p2" } },
    ]);
    lib.snapshot(a, "before-delete-page");
    a.file.commit([{ seq: 2, ops: [{ op: "deletePage", id: "p2" }] }]);
    // Crash: never closed. The committed delete survives the unclean exit.
    const b = new Library(dir).openBoard(id);
    expect(b.recovery?.kind).toBe("unclean-exit");
    expect(b.meta.pages.map((p) => p.id)).toEqual(["p1"]);
    a.file.close();
    lib.closeBoard(b);

    // Damage the file: the snapshot taken before the delete brings both pages back.
    const p = lib.boardPath(id);
    const bytes = fs.readFileSync(p);
    bytes.fill(0xab, 100);
    fs.writeFileSync(p, bytes);
    const c = lib.openBoard(id);
    expect(c.recovery?.kind).toBe("restored-snapshot");
    expect(c.meta.pages.map((x) => [x.id, x.name, x.background])).toEqual([
      ["p1", "", "grid"],
      ["p2", "Two", "dots"],
    ]);
    expect(c.meta.activePage).toBe("p2");
    expect(c.objects.map((o) => [o.id, o.page])).toEqual([
      ["a1", "p1"],
      ["b1", "p2"],
    ]);
    expect(lib.listSnapshots(id)[0]?.reason).toBe("before-delete-page");
    lib.closeBoard(c);
  });

  it("opens a version 1 board from the library and restores a version 1 snapshot", () => {
    const lib = new Library(dir);
    const id = "0b0b0b0b-1111-2222-3333-444444444444";
    writeV1File(lib.boardPath(id));
    const snapDir = path.join(lib.snapshotsDir, id);
    fs.mkdirSync(snapDir, { recursive: true });
    writeV1File(path.join(snapDir, "1000-auto.nlsnap"));
    expect(lib.verifySnapshot(path.join(snapDir, "1000-auto.nlsnap"))).toBe(true);
    const a = lib.openBoard(id);
    expect(a.recovery).toBeUndefined();
    expect(a.objects.map((o) => o.id)).toEqual(["s1"]);
    lib.closeBoard(a);
    fs.writeFileSync(lib.boardPath(id), "garbage");
    const b = lib.openBoard(id);
    expect(b.recovery?.kind).toBe("restored-snapshot");
    expect(b.meta.pages[0]).toMatchObject({ id: "p1", background: "ruled" });
    expect(b.objects.map((o) => o.id)).toEqual(["s1"]);
    lib.closeBoard(b);
  });

  it("starts an empty board when a damaged file has no snapshot", () => {
    const lib = new Library(dir);
    const id = lib.createBoard();
    fs.writeFileSync(lib.boardPath(id), "garbage");
    const b = lib.openBoard(id);
    expect(b.recovery?.kind).toBe("damaged-no-backup");
    expect(b.objects).toEqual([]);
    lib.closeBoard(b);
  });

  it("leaves a board from a newer version untouched instead of treating it as damaged", () => {
    const lib = new Library(dir);
    const id = lib.createBoard("From the future");
    const a = lib.openBoard(id);
    a.file.commit([{ seq: 1, ops: [put("s1", 0)] }]);
    lib.snapshot(a, "manual");
    lib.closeBoard(a);
    const db = new DatabaseSync(lib.boardPath(id));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const before = fs.readFileSync(lib.boardPath(id));
    expect(() => lib.openBoard(id)).toThrow(BoardUnavailableError);
    expect(fs.readFileSync(lib.boardPath(id)).equals(before)).toBe(true);
    expect(fs.readdirSync(lib.damagedDir)).toEqual([]);
    expect(fs.existsSync(`${lib.boardPath(id)}.open`)).toBe(false);
  });

  it("tells locked or unreadable files apart from damaged ones", () => {
    const sqliteError = (errcode: number) => Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR", errcode });
    expect(isUnavailable(sqliteError(5))).toBe(true); // busy
    expect(isUnavailable(sqliteError(261))).toBe(true); // busy (extended code)
    expect(isUnavailable(sqliteError(14))).toBe(true); // cannot open
    expect(isUnavailable(Object.assign(new Error("x"), { code: "EBUSY" }))).toBe(true);
    expect(isUnavailable(sqliteError(11))).toBe(false); // corrupt
    expect(isUnavailable(sqliteError(26))).toBe(false); // not a database
    expect(isUnavailable(new Error("not a NovaLoomBoard file"))).toBe(false);
  });

  it("does not apply a leftover write-ahead log to a file replaced by Save a copy", () => {
    const lib = new Library(dir);
    const dest = path.join(dir, "replace-me.nlboard");
    // An old board at the destination that was not closed cleanly: its WAL still holds a change.
    const old = BoardFile.create(dest, { boardId: "old-board", title: "Old" });
    old.commit([{ seq: 1, ops: [put("old", 0)] }]);
    const wal = fs.readFileSync(`${dest}-wal`);
    old.close();
    fs.writeFileSync(`${dest}-wal`, wal);
    const b = lib.openBoard(lib.createBoard("New"));
    b.file.commit([{ seq: 1, ops: [put("new", 0)] }]);
    lib.exportCopy(b, dest);
    lib.closeBoard(b);
    expect(fs.existsSync(`${dest}-wal`)).toBe(false);
    const f = BoardFile.open(dest, { readOnly: true });
    expect(f.verify()).toEqual([]);
    expect(f.readMeta().title).toBe("New");
    expect(f.readObjects().map((o) => o.id)).toEqual(["new"]);
    f.close();
  });

  it("keeps a bounded number of automatic snapshots", () => {
    const lib = new Library(dir);
    const b = lib.openBoard(lib.createBoard());
    for (let i = 0; i < 33; i++) lib.snapshot(b, "auto");
    lib.snapshot(b, "manual");
    expect(lib.listSnapshots(b.id).length).toBe(31);
    lib.closeBoard(b);
  });

  it("exports a copy including pending changes, and imports it as a new board with all pages", () => {
    const lib = new Library(dir);
    const b = lib.openBoard(lib.createBoard("Export me"));
    b.file.commit([{ seq: 1, ops: [put("s1", 0), addPage("p2", 1, { name: "Two", background: "dots" }), put("t1", 0, 0, "p2")] }]);
    const dest = path.join(dir, "copy.nlboard");
    lib.exportCopy(b, dest, [{ seq: 2, ops: [put("s2", 1)], props: { title: "Export me", activePage: "p2" } }]);
    expect(b.file.objectCount()).toBe(2); // the live board is untouched
    lib.closeBoard(b);

    const id = lib.importCopy(dest);
    expect(id).not.toBe(b.id);
    const c = lib.openBoard(id);
    expect(c.meta.title).toBe("Export me");
    expect(c.meta.activePage).toBe("p2");
    expect(c.meta.pages.map((p) => [p.id, p.name, p.background])).toEqual([
      ["p1", "", "grid"],
      ["p2", "Two", "dots"],
    ]);
    expect(c.objects.map((o) => [o.id, o.page])).toEqual([
      ["s1", "p1"],
      ["s2", "p1"],
      ["t1", "p2"],
    ]);
    lib.closeBoard(c);
  });

  it("imports a version 1 file", () => {
    const lib = new Library(dir);
    const src = path.join(dir, "old.nlboard");
    writeV1File(src);
    const c = lib.openBoard(lib.importCopy(src));
    expect(c.meta.pages).toEqual([pageRow("p1", 0, { background: "ruled", view: { x: 10, y: 20, zoom: 1.5 } })]);
    expect(c.objects.map((o) => o.id)).toEqual(["s1"]);
    lib.closeBoard(c);
    expect(userVersion(src)).toBe(1); // the source file is never modified
  });

  it("refuses to import a damaged file", () => {
    const lib = new Library(dir);
    const src = path.join(dir, "bad.nlboard");
    fs.writeFileSync(src, "not a board");
    expect(() => lib.importCopy(src)).toThrow();
    expect(fs.readdirSync(lib.boardsDir)).toEqual([]);
  });
});

/** A board file exactly as version 1 (single page) wrote it. */
function writeV1File(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE pages (id TEXT PRIMARY KEY, position REAL NOT NULL, background TEXT NOT NULL) STRICT;
    CREATE TABLE objects (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      z REAL NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, points BLOB NOT NULL
    ) STRICT;
    CREATE INDEX objects_page_z ON objects(page_id, z);
    PRAGMA application_id = ${0x42444231};
    PRAGMA user_version = 1;
  `);
  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of [
    ["boardId", "old"],
    ["title", "Old board"],
    ["createdAt", "1"],
    ["modifiedAt", "2"],
    ["lastAppliedSeq", "3"],
    ["view", JSON.stringify({ x: 10, y: 20, zoom: 1.5 })],
  ]) {
    meta.run(k!, v!);
  }
  db.prepare("INSERT INTO pages (id, position, background) VALUES ('p1', 0, 'ruled')").run();
  const s = encodeObject(stroke("s1"), 0);
  db.prepare("INSERT INTO objects VALUES (?, 'p1', ?, ?, ?, ?)").run(s.id, s.z, s.type, s.data, s.points);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

function userVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}
