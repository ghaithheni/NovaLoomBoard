import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  BACKGROUNDS,
  decodeObject,
  viewOf,
  type BoardProps,
  type PageRow,
  type StoreOp,
  type StoredObject,
} from "@novaloom/board-engine/persist";
import type { Background } from "@novaloom/board-engine";

export const FILE_EXT = ".nlboard";
/**
 * 1: single page (pages table without name/view; the view lived in meta).
 * 2: multiple pages, each with a name and its own view.
 * 3: an assets table holding image files (one row per distinct image).
 */
export const SCHEMA_VERSION = 3;
/** "NLB1": identifies NovaLoomBoard files in the SQLite header. */
const APPLICATION_ID = 0x4e4c4231;
/** The identifier written by pre-release builds; such files open normally and take the current one when saved. */
const PRERELEASE_APPLICATION_ID = 0x42444231;
/** The page every new board starts with (and the only page of version 1 files). */
export const DEFAULT_PAGE = "p1";

export interface BoardMeta {
  boardId: string;
  title: string;
  /** In page order. Never empty for a file opened for writing. */
  pages: PageRow[];
  /** The page to show on open (falls back to the first page). */
  activePage: string;
  createdAt: number;
  modifiedAt: number;
  lastAppliedSeq: number;
}

/** A stored object with the page it belongs to. */
export interface PagedObject extends StoredObject {
  page: string;
}

/** One unit of work for {@link BoardFile.commit}: ops plus board properties, with a sequence number. */
export interface CommitEntry {
  seq: number;
  ops: readonly StoreOp[];
  props?: BoardProps;
}

/**
 * The file cannot be opened right now, but nothing shows it is damaged: it
 * was saved by a newer version, or it is locked, read-only or unreadable at
 * the moment. Such a file must be left exactly as it is.
 */
export class BoardUnavailableError extends Error {}

/** SQLite result codes that say "not now" rather than "damaged". */
const UNAVAILABLE_CODES = new Set([3 /* PERM */, 5 /* BUSY */, 6 /* LOCKED */, 7 /* NOMEM */, 8 /* READONLY */, 10 /* IOERR */, 13 /* FULL */, 14 /* CANTOPEN */, 23 /* AUTH */]);

/** True for errors that do not mean the file is damaged (see {@link BoardUnavailableError}). */
export function isUnavailable(err: unknown): boolean {
  if (err instanceof BoardUnavailableError) return true;
  const code = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number") return UNAVAILABLE_CODES.has(code & 0xff);
  const fsCode = (err as { code?: unknown } | null)?.code;
  return fsCode === "EBUSY" || fsCode === "EPERM" || fsCode === "EACCES";
}

export class SequenceGapError extends Error {
  constructor(expected: number, got: number) {
    super(`sequence gap: expected ${expected}, got ${got}`);
  }
}

/** Image files by SHA-256 (hex); image objects refer to them. */
const ASSETS_TABLE = `CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL) STRICT;`;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  position REAL NOT NULL,
  background TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  view TEXT
) STRICT;
CREATE TABLE objects (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  z REAL NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  points BLOB NOT NULL
) STRICT;
CREATE INDEX objects_page_z ON objects(page_id, z);
${ASSETS_TABLE}
`;

/**
 * One board stored as a single SQLite file (WAL, synchronous=FULL).
 * Every commit is one atomic transaction that also records the last
 * applied sequence number, so retries never apply a change twice.
 */
export class BoardFile {
  private constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
    readonly readOnly: boolean,
    /** A version 1 file opened read-only (not upgraded): pages have no name or view columns. */
    private readonly legacy = false,
    /** False for an older file opened read-only (it has no assets table). */
    private readonly hasAssets = true,
  ) {}

  private closed = false;

  static create(path: string, init: { boardId: string; title: string; now?: number }): BoardFile {
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      configure(db, false);
      const now = init.now ?? Date.now();
      db.exec("BEGIN IMMEDIATE");
      db.exec(SCHEMA);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`);
      const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      put.run("boardId", init.boardId);
      put.run("title", init.title);
      put.run("createdAt", String(now));
      put.run("modifiedAt", String(now));
      put.run("lastAppliedSeq", "0");
      db.prepare("INSERT INTO pages (id, position, background) VALUES (?, 0, 'grid')").run(DEFAULT_PAGE);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.close();
      } catch {
        /* already failing */
      }
      throw err;
    }
    return new BoardFile(path, db, false);
  }

  /**
   * Opens an existing board file. Throws if it is not a NovaLoomBoard file or is
   * from a newer version. Opening an older file for writing upgrades it in
   * one transaction; read-only opens leave it untouched.
   */
  static open(path: string, opts: { readOnly?: boolean } = {}): BoardFile {
    const readOnly = opts.readOnly ?? false;
    const db = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
    let legacy = false;
    let version = 0;
    try {
      configure(db, readOnly);
      const appId = (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      if (appId !== APPLICATION_ID && appId !== PRERELEASE_APPLICATION_ID) throw new Error("not a NovaLoomBoard file");
      version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > SCHEMA_VERSION) throw new BoardUnavailableError("this board was saved by a newer version of NovaLoomBoard");
      if (version < 1) throw new Error("unsupported board file version");
      if (appId !== APPLICATION_ID && !readOnly) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      if (version === 1) {
        if (readOnly) legacy = true;
        else migrateV1(db);
      }
      if (version < 3 && !readOnly) migrateV2(db);
      if (!readOnly) ensurePage(db);
    } catch (err) {
      db.close();
      throw err;
    }
    return new BoardFile(path, db, readOnly, legacy, readOnly ? version >= 3 : true);
  }

  readMeta(): BoardMeta {
    const rows = this.db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const m = new Map(rows.map((r) => [r.key, r.value]));
    const pages = this.readPages();
    const active = m.get("activePage");
    return {
      boardId: m.get("boardId") ?? "",
      title: m.get("title") ?? "Untitled board",
      pages,
      activePage: pages.some((p) => p.id === active) ? active! : (pages[0]?.id ?? DEFAULT_PAGE),
      createdAt: Number(m.get("createdAt") ?? 0),
      modifiedAt: Number(m.get("modifiedAt") ?? 0),
      lastAppliedSeq: Number(m.get("lastAppliedSeq") ?? 0),
    };
  }

  /** Pages in display order. */
  readPages(): PageRow[] {
    const sql = this.legacy
      ? "SELECT id, position, background, '' AS name, (SELECT value FROM meta WHERE key = 'view') AS view FROM pages ORDER BY position, id"
      : "SELECT id, position, background, name, view FROM pages ORDER BY position, id";
    const rows = this.db.prepare(sql).all() as {
      id: string;
      position: number;
      background: string;
      name: string;
      view: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      position: r.position,
      name: r.name,
      background: BACKGROUNDS.includes(r.background as Background) ? (r.background as Background) : "grid",
      view: parseView(r.view),
    }));
  }

  /** Objects bottom first: of one page, or of every page. */
  readObjects(page?: string): PagedObject[] {
    const cols = "SELECT id, page_id AS page, type, z, data, points FROM objects";
    return (
      page === undefined
        ? this.db.prepare(`${cols} ORDER BY page_id, z, id`).all()
        : this.db.prepare(`${cols} WHERE page_id = ? ORDER BY z, id`).all(page)
    ) as unknown as PagedObject[];
  }

  // ---------- images ----------

  /**
   * Stores an image file under its id (SHA-256), committed at once. Images
   * are written before any object refers to them, so a crash can never
   * leave an image object without its pixels. Storing the same image twice
   * keeps one copy.
   */
  putAsset(id: string, mime: string, data: Uint8Array): void {
    if (this.readOnly) throw new Error("board is open read-only");
    this.db.prepare("INSERT OR IGNORE INTO assets (id, mime, data) VALUES (?, ?, ?)").run(id, mime, data);
  }

  getAsset(id: string): { mime: string; data: Uint8Array } | null {
    if (!this.hasAssets) return null;
    const row = this.db.prepare("SELECT mime, data FROM assets WHERE id = ?").get(id) as { mime: string; data: Uint8Array } | undefined;
    return row ? { mime: row.mime, data: new Uint8Array(row.data) } : null;
  }

  assetIds(): string[] {
    if (!this.hasAssets) return [];
    return (this.db.prepare("SELECT id FROM assets").all() as { id: string }[]).map((r) => r.id);
  }

  /**
   * Deletes images no object refers to (left by undone imports or deleted
   * objects). Only safe when no undo history can bring such objects back,
   * i.e. when the board is opened. Returns how many were removed.
   */
  deleteUnusedAssets(): number {
    if (this.readOnly) return 0;
    const r = this.db
      .prepare(
        `DELETE FROM assets WHERE id NOT IN (
           SELECT json_extract(data, '$.asset') FROM objects WHERE type = 'image' AND json_valid(data))`,
      )
      .run();
    return Number(r.changes);
  }

  objectCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM objects").get() as { n: number }).n;
  }

  /**
   * Applies entries in one transaction. Entries with seq ≤ lastAppliedSeq are
   * skipped as duplicates; a gap throws {@link SequenceGapError} and nothing
   * is written. Any error rolls back the whole transaction.
   */
  commit(entries: readonly CommitEntry[], now = Date.now()): { applied: number; skipped: number } {
    if (this.readOnly) throw new Error("board is open read-only");
    let applied = 0;
    let skipped = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let last = this.readMeta().lastAppliedSeq;
      const put = this.db.prepare(
        // Shapes, text and images have no points: an empty blob. Node 22's node:sqlite
        // binds an empty Uint8Array it returned itself (e.g. from readObjects) as NULL,
        // so the empty blob is written by SQLite rather than taken from the argument.
        "INSERT OR REPLACE INTO objects (id, page_id, z, type, data, points) VALUES (?, ?, ?, ?, ?, coalesce(?, x''))",
      );
      const del = this.db.prepare("DELETE FROM objects WHERE id = ?");
      const setZ = this.db.prepare("UPDATE objects SET z = ? WHERE id = ?");
      // Upsert, never REPLACE: replacing a page row would cascade-delete its objects.
      const putPage = this.db.prepare(
        `INSERT INTO pages (id, position, background, name, view) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET position = excluded.position, background = excluded.background,
           name = excluded.name, view = excluded.view`,
      );
      const delPage = this.db.prepare("DELETE FROM pages WHERE id = ?");
      for (const entry of entries) {
        if (entry.seq <= last) {
          skipped++;
          continue;
        }
        if (entry.seq !== last + 1) throw new SequenceGapError(last + 1, entry.seq);
        for (const op of entry.ops) {
          switch (op.op) {
            case "put": {
              const o = op.object;
              if (!ArrayBuffer.isView(o.points)) throw new Error(`object ${o.id} has no point data`);
              put.run(o.id, op.page, o.z, o.type, o.data, o.points);
              break;
            }
            case "delete":
              del.run(op.id);
              break;
            case "setZ":
              setZ.run(op.z, op.id);
              break;
            case "putPage": {
              const p = op.page;
              putPage.run(p.id, p.position, p.background, p.name.slice(0, 100), p.view ? JSON.stringify(p.view) : null);
              break;
            }
            case "updatePage":
              this.updatePage(op);
              break;
            case "deletePage":
              delPage.run(op.id);
              break;
          }
        }
        if (entry.props) this.writeProps(entry.props);
        last = entry.seq;
        applied++;
      }
      if (applied > 0) {
        this.setMeta("lastAppliedSeq", String(last));
        this.setMeta("modifiedAt", String(now));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      rollback(this.db);
      throw err;
    }
    return { applied, skipped };
  }

  /**
   * Integrity check used on every open and during recovery: SQLite
   * quick_check and foreign_key_check (every object belongs to a page), then
   * the engine invariants (every object decodes, z keys are finite).
   */
  verify(): string[] {
    const problems: string[] = [];
    try {
      const qc = this.db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
      for (const r of qc) if (r.quick_check !== "ok") problems.push(`quick_check: ${r.quick_check}`);
      if (problems.length) return problems;
      const fk = this.db.prepare("PRAGMA foreign_key_check").all();
      if (fk.length) problems.push(`foreign_key_check: ${fk.length} violation(s)`);
      for (const page of this.readPages()) {
        if (page.id.length === 0 || page.id.length > 64) problems.push("invalid page id");
        if (!Number.isFinite(page.position)) problems.push(`page ${page.id}: invalid position`);
      }
      const assetIds = new Set(this.assetIds());
      for (const row of this.readObjects()) {
        try {
          const obj = decodeObject(row);
          if (obj.type === "image" && !assetIds.has(obj.asset)) problems.push(`object ${row.id}: image data missing`);
        } catch (err) {
          problems.push((err as Error).message);
        }
        if (!Number.isFinite(row.z)) problems.push(`object ${row.id}: invalid z`);
        if (problems.length > 20) break;
      }
      const meta = this.readMeta();
      if (!meta.boardId) problems.push("missing board id");
      if (!Number.isInteger(meta.lastAppliedSeq) || meta.lastAppliedSeq < 0) problems.push("invalid sequence number");
    } catch (err) {
      // A locked or unreadable file is not a damaged one.
      if (isUnavailable(err)) throw err;
      problems.push((err as Error).message);
    }
    return problems;
  }

  /** Writes a compact, consistent copy of the database to `dest` (must not exist). */
  vacuumInto(dest: string): void {
    this.db.prepare("VACUUM INTO ?").run(dest);
  }

  /** Copies the WAL into the main file. TRUNCATE also empties the WAL. */
  checkpoint(mode: "PASSIVE" | "TRUNCATE" = "PASSIVE"): void {
    if (!this.readOnly) this.db.exec(`PRAGMA wal_checkpoint(${mode})`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private writeProps(props: BoardProps): void {
    if (props.title !== undefined) this.setMeta("title", props.title.slice(0, 200));
    if (props.activePage !== undefined) this.setMeta("activePage", props.activePage);
  }

  private updatePage(op: Extract<StoreOp, { op: "updatePage" }>): void {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    if (op.position !== undefined) {
      sets.push("position = ?");
      values.push(op.position);
    }
    if (op.name !== undefined) {
      sets.push("name = ?");
      values.push(op.name.slice(0, 100));
    }
    if (op.background !== undefined && BACKGROUNDS.includes(op.background)) {
      sets.push("background = ?");
      values.push(op.background);
    }
    if (op.view !== undefined) {
      sets.push("view = ?");
      values.push(JSON.stringify(op.view));
    }
    if (sets.length) this.db.prepare(`UPDATE pages SET ${sets.join(", ")} WHERE id = ?`).run(...values, op.id);
  }

  private setMeta(key: string, value: SQLInputValue): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }
}

/**
 * Ends a failed transaction. SQLite may already have rolled it back itself
 * (on a full disk, for example), so "no transaction is active" is expected.
 * Avoids `db.isTransaction`, which Node 22 only has from 22.16.
 */
function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // nothing to roll back
  }
}

/** Version 1 → 2: page names and per-page views. The board-wide view becomes the first page's. */
function migrateV1(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE pages ADD COLUMN name TEXT NOT NULL DEFAULT '';
      ALTER TABLE pages ADD COLUMN view TEXT;
      UPDATE pages SET view = (SELECT value FROM meta WHERE key = 'view');
      DELETE FROM meta WHERE key = 'view';
      PRAGMA user_version = 2;
    `);
    db.exec("COMMIT");
  } catch (err) {
    rollback(db);
    throw err;
  }
}

/** Version 2 → 3: the assets table. */
function migrateV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`${ASSETS_TABLE} PRAGMA user_version = 3;`);
    db.exec("COMMIT");
  } catch (err) {
    rollback(db);
    throw err;
  }
}

/** A board always has at least one page. */
function ensurePage(db: DatabaseSync): void {
  const n = (db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number }).n;
  if (n === 0) db.prepare("INSERT INTO pages (id, position, background) VALUES (?, 0, 'grid')").run(DEFAULT_PAGE);
}

function parseView(json: string | null): PageRow["view"] {
  if (!json) return null;
  try {
    return viewOf(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * The state a file would have after committing `entries`, computed in
 * memory (used when entries could not be written yet, e.g. disk full).
 */
export function replayEntries(
  meta: BoardMeta,
  objects: readonly PagedObject[],
  entries: readonly CommitEntry[],
): { meta: BoardMeta; objects: PagedObject[] } {
  const pages = new Map(meta.pages.map((p) => [p.id, { ...p }]));
  const objs = new Map(objects.map((o) => [o.id, o]));
  let { title, activePage } = meta;
  for (const entry of entries) {
    for (const op of entry.ops) {
      switch (op.op) {
        case "put":
          objs.set(op.object.id, { ...op.object, page: op.page });
          break;
        case "delete":
          objs.delete(op.id);
          break;
        case "setZ": {
          const o = objs.get(op.id);
          if (o) objs.set(op.id, { ...o, z: op.z });
          break;
        }
        case "putPage":
          pages.set(op.page.id, { ...op.page });
          break;
        case "updatePage": {
          const p = pages.get(op.id);
          if (!p) break;
          if (op.position !== undefined) p.position = op.position;
          if (op.name !== undefined) p.name = op.name;
          if (op.background !== undefined) p.background = op.background;
          if (op.view !== undefined) p.view = op.view;
          break;
        }
        case "deletePage":
          pages.delete(op.id);
          for (const [id, o] of objs) if (o.page === op.id) objs.delete(id);
          break;
      }
    }
    if (entry.props?.title !== undefined) title = entry.props.title;
    if (entry.props?.activePage !== undefined) activePage = entry.props.activePage;
  }
  const pageList = [...pages.values()].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  if (!pageList.some((p) => p.id === activePage)) activePage = pageList[0]?.id ?? DEFAULT_PAGE;
  return {
    meta: { ...meta, title, activePage, pages: pageList },
    objects: [...objs.values()].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1)),
  };
}

function configure(db: DatabaseSync, readOnly: boolean): void {
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000;");
  }
}
