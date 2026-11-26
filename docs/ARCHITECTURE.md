# Architecture

NovaLoomBoard is a desktop whiteboard built as a small pnpm monorepo. Each package has one job and a narrow interface, so the drawing engine, the storage layer and the shell around them can change independently.

```
┌──────────────────────────── Electron renderer (sandboxed) ────────────────────────────┐
│  apps/web  (React 19)                                                                 │
│    title bar · toolbars · dialogs · page navigator · presentation mode               │
│         │ commands / state                    ▲ DocumentChange events                │
│         ▼                                     │                                       │
│  packages/board-engine  (framework-free TypeScript, <canvas>)                         │
│    tools · objects · hit-testing · history · rendering · PDF/PNG/SVG export           │
│         │                                                                             │
│  apps/web/src/persistence.ts  ── batches changes into StoreOps ──┐                    │
└──────────────────────────────────────────────────────────────────┼────────────────────┘
                                         window.novaLoom (preload)  │ IPC
┌──────────────────────────── Electron main process ───────────────▼────────────────────┐
│  apps/desktop/src/main.ts                                                             │
│    validates every message · window and menus · file dialogs · clipboard · export    │
│         │                                                                             │
│  packages/board-store                                                                 │
│    Journal (batched commits) → BoardFile (SQLite) · Library (recents, snapshots)      │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                       %LOCALAPPDATA%\NovaLoomBoard\boards\<id>.nlboard
```

## Packages

### `packages/board-engine`

The whiteboard itself: everything you can see and touch on the canvas. It has no dependency on React or Electron, so it can be tested in Node and reused in another shell.

- **Model** (`model.ts`): plain, serialisable objects (strokes, shapes, text, images) with precomputed bounds.
- **Operations and history** (`ops.ts`, `history.ts`, `pages.ts`): every edit is a batch of operations with an exact inverse, which makes undo/redo, page changes and saving all use the same path.
- **Rendering** (`renderer.ts`, `draw.ts`): a layered canvas renderer. Committed content is cached; only the live stroke and overlays redraw each frame. The live stroke keeps the settled part of its outline in a cache, so each frame only computes and fills its last few points, however long the stroke (`liveInk.ts`, `liveLayer.ts`). Ink outlines come from [perfect-freehand](https://github.com/steveruizok/perfect-freehand), and an R-tree ([rbush](https://github.com/mourner/rbush)) makes hit-testing and viewport culling fast on large boards.
- **Input** (`engine.ts`): pointer events for mouse, pen and touch, tools, selection, transforms, guides and the shape recogniser (`recognize.ts`).
- **Export** (`export.ts`, `thumbnail.ts`): PNG pages, vector SVG sheets for PDF export, and thumbnails, all drawn from the same geometry as the screen.
- **Persistence contract** (`persist.ts`): the encoded form of objects, strict validators for everything that crosses a process boundary, and the TypeScript types of the desktop bridge.
- **Plotting** (`plot.ts`): a hand-written recursive-descent parser for formulas. It never calls `eval`.

The package is consumed as TypeScript source (there is no separate build step). Vite and esbuild compile it as part of the apps.

### `packages/board-store`

Durable storage, running in the main process only.

- **`BoardFile`**: one board is one SQLite database (Node's built-in `node:sqlite`) with tables for metadata, pages, objects and images. The SQLite header carries an application ID and a schema version. Older schemas are upgraded in a single transaction when a file is opened for writing; read-only opens never change a file. Writes use WAL with `synchronous = FULL`.
- **`Journal`**: changes from the interface are numbered and committed in small batches (at most about 150 ms after the first pending change). A failed commit, for example on a full disk, keeps every pending entry and retries, so nothing is silently dropped. Sequence numbers make replays idempotent.
- **`Library`**: the folder of boards, the recents list, crash detection (an `.open` marker per board) and verified snapshots for version history. A board that fails verification on open is moved to `damaged/` and the newest good snapshot is offered instead.

### `apps/web`

The interface, in React 19 with Vite. It owns layout, toolbars, dialogs, keyboard shortcuts and presentation mode, and drives the engine through its public methods. `persistence.ts` turns engine change events into store operations and talks to the main process through `window.novaLoom`. When that bridge is missing (`pnpm dev:web`), the interface runs without saving.

MathJax, the largest dependency, loads only the first time the equation dialog opens. pdf.js decodes PDFs in a Web Worker.

### `apps/desktop`

The Electron shell.

- **`main.ts`**: windows, the custom title bar's native menus, file dialogs, clipboard, image and PDF import, PDF printing, and the bridge to `board-store`.
- **`preload.ts`**: exposes a small, typed API as `window.novaLoom` through `contextBridge`. The renderer has no direct access to Node or Electron.
- **`scripts/`**: `dev.mjs` (Vite plus Electron), `build.mjs` (esbuild bundles for main and preload) and `package.mjs` (electron-builder; see [PACKAGING.md](PACKAGING.md)).

## Security model

The renderer is treated as untrusted. A board file, a pasted object or an imported PDF should never be able to reach the file system or run code.

- Every renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`. Permission requests are denied, new windows are blocked, and navigation away from the app is cancelled.
- The production build sets a strict Content-Security-Policy. Scripts load only from the app itself, and there are no remote connections at all.
- The main process accepts IPC only from the main window's top frame, and validates every argument: operation batches, object encodings, image bytes (sniffed, size-capped), asset IDs and export paths. The same validators run when a board file is read.
- PDF export prints vector SVG in a hidden window with JavaScript disabled.
- Packaged builds turn on Electron fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, ASAR integrity validation, and loading only from the app archive. Remote-debugging switches are stripped at startup.

## Design decisions

| Decision | Why |
| --- | --- |
| **Local-first, no accounts or network** | A whiteboard should open instantly and work anywhere. Without a server there is nothing to sign in to, nothing to leak and nothing to shut down. |
| **One SQLite file per board** | Atomic transactions, crash safety and incremental saves, in a single file that is easy to copy. `node:sqlite` is built into Node and Electron, so there is no native module to rebuild. |
| **Engine separate from React** | Drawing runs at pointer rate. Keeping it in plain TypeScript with a canvas avoids re-rendering React on every point, and makes the engine testable in Node. |
| **Operations with inverses** | One mechanism serves undo/redo, saving and replaying after a crash. |
| **Validate at every boundary** | Files and clipboards come from outside. Strict decoding means a malformed board is reported, not executed or half-loaded. |
| **Snapshots before destructive actions** | Clearing a page or deleting one is recoverable from version history even after undo history is gone. |
| **Pre-release file compatibility** | Files written by pre-release builds carry an older header ID. They still open, and get the current ID the next time they are saved. |

## Pen prediction

While you draw, the ink is extended a few milliseconds ahead of the pen to hide part of the input and display delay (`predict.ts`). The predicted points exist only for the frame being drawn: the stroke that is saved, exported and undone is always the real input.

- **Our own predictor, not Chromium's.** Chromium's `getPredictedEvents()` uses a Kalman filter that extrapolates acceleration as well, which overshoots at turns and stops, and its settings come from field trials we can't test against. The delegated ink trail (`navigator.ink`) draws one width and colour per frame, so it can't follow pressure, perfect-freehand's shape or the highlighter.
- **Cautious by design.** Constant velocity fitted over the last 32 ms, 8 ms ahead, at most 20 screen pixels. It fades in as a stroke starts, and fades out when the pen turns, brakes, or stops sending input. Predicting along an arc and a 12 ms horizon were tried; both strayed further from the path on noisy input or tight loops.

Measured on simulated 240 Hz input with ±0.5 px jitter (`predictSim.ts`; the tests enforce these bounds). "Error" is the distance to where the pen is 8 ms later; "off path" is the furthest the predicted tip strays from where the pen actually goes.

| Movement | Error without → with | Off path, max |
| --- | --- | --- |
| Straight line, 600 px/s | 4.8 → 0.8 px | 0.6 px |
| Circle, 500 px/s | 4.0 → 1.0 px | 1.3 px |
| Corner the pen slows into | 3.8 → 1.0 px | 0.6 px |
| Fast handwriting loops (to 1,500 px/s) | 8.0 → 4.6 px | 3.6 px |
| Instant 90° turn or reversal | 4.8 → 1.2 px | 4.7 px, for 2 samples |
| Instant stop from 800 px/s | 3.3 → 0.8 px | 6.3 px, for 2 samples |

An instant turn or stop can't be foreseen, so the tip passes it for at most two samples (8 ms), never further than the pen travels in 8 ms. Real pens slow into corners, which the predictor follows closely. In the app, drawing at 600 px/s, the ink reached 5 px further towards the pen, frame times were unchanged (4.2 ms at 240 Hz), and saved strokes matched the real input. This was measured with simulated pen input; it has not yet been tried on pen hardware.

## Testing

Tests live next to the code (`*.test.ts`) and run with Vitest from the repository root (`pnpm test`). They cover the engine (editing, history, pages, export, recognition, plotting), the store (crash recovery, migrations, journal retry, snapshots), and keyboard handling. Property-based tests use fast-check.

The desktop shell is exercised by running the app. In development, the engine and persistence objects are exposed on `window` (`__nlbEngine`, `__nlbPersistence`) so end-to-end checks can be scripted over the Chrome DevTools Protocol.
