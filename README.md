<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/wordmark-dark.png">
    <img src="assets/brand/wordmark-light.png" alt="NovaLoomBoard" width="420">
  </picture>
</p>

<p align="center">
  A fast, open-source digital whiteboard for Windows.<br>
  Sketch, explain, plot and present on an infinite canvas. Everything saves as you go, and it all stays on your computer.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3DD6C6"></a>
  <img alt="Platform: Windows 10 and 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-1A1C4B">
  <img alt="Built with Electron and React" src="https://img.shields.io/badge/built%20with-Electron%20%2B%20React-FFC24B">
</p>

![NovaLoomBoard with a diagram, a checklist and an equation on a dotted board](docs/screenshots/board-light.png)

## Why NovaLoomBoard

- **It feels like ink.** Pen, pencil and highlighter strokes are smoothed as you draw. If you hold still at the end of a stroke, it becomes a clean line, circle, rectangle or arrow.
- **Nothing gets lost.** Every change is written to disk within moments, and the board is checked when it opens. Version history keeps restorable copies.
- **It's all local.** There are no accounts, no cloud and no telemetry. Boards are ordinary files you can copy, back up and share.
- **It's made for presenting.** Full-screen presentation mode, a laser pointer, spotlight, screen shade and a timer are all one key away.

![A chalkboard with two plotted functions and the board tools panel, in the dark interface](docs/screenshots/chalkboard-plot.png)

## Features

**Drawing and writing**
- Pen, pencil and highlighter, with pen pressure support and touch input.
- Shape recognition: hold still after a stroke to straighten it.
- Shapes: line, arrow, rectangle, ellipse, triangle, diamond, star, hexagon, speech bubble, check mark and cross. All of them can be solid, dashed or dotted.
- Text boxes that wrap, with quick size controls.
- An eraser that removes whole strokes or parts of strokes, plus a laser pointer that fades away.
- Ruler and protractor guides you can draw along.

**Maths and science**
- **Plot a function:** type `y = x³ − 3x`, `2 sin x` or `1/x` the way you would write it. The curve is drawn on a coordinate grid, with breaks where the function is undefined. The formula reader is a small parser and never runs your input as code.
- **Equations:** insert typeset equations with symbol buttons or TeX, including chemistry (`\ce{2H2 + O2 -> 2H2O}`), rendered by MathJax. Double-click an equation to edit it.
- Backgrounds: blank, grid, dots, ruled, music staff, handwriting lines, Seyès and axes. Each comes on a white, chalkboard-green or black board.

**Organising**
- An infinite canvas with smooth zoom and pan.
- Multiple pages per board, with thumbnails, renaming and reordering.
- Select with a box or a lasso. Group, lock, align, distribute, rotate and duplicate.
- Undo and redo across every action, including page changes.

**Files and sharing**
- Import images and PDF pages (rendered locally with pdf.js).
- Export a board as a vector PDF, or a page as PNG.
- Copy as image: `Ctrl+C` puts a picture on the clipboard for other apps, and editable objects for NovaLoomBoard.
- Version history: automatic snapshots every few minutes of work and before destructive actions. You can restore any version as a copy.

**Presenting**
- Presentation mode (`F5`) with a minimal toolbar that hides itself.
- Spotlight, screen shade, and a timer and stopwatch with a gentle chime.

**Comfort**
- Light and dark interface that follows Windows.
- Keyboard shortcuts for everything (`F1` lists them), including on AZERTY and other layouts.
- Touch-friendly controls and high-DPI rendering.

## Download

There is no release build yet. To try NovaLoomBoard now, [build it from source](#development).

## Requirements

**To run:** Windows 10 version 2004 or later, or Windows 11, on x64.

**To build from source:**
- [Node.js](https://nodejs.org/) 22.13 or later (24 LTS recommended). The app uses Node's built-in `node:sqlite`.
- [pnpm](https://pnpm.io/) 12. Run `corepack enable` and the version pinned in `package.json` is used.
- Git.

Windows is the platform NovaLoomBoard is developed and tested on. The code is standard Electron and may run from source on macOS or Linux, but that is untested and the packaging scripts target Windows only.

## Development

```sh
git clone https://github.com/ghaithheni/NovaLoomBoard.git
cd NovaLoomBoard
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite dev server and opens the desktop app pointed at it, with hot reload for the interface. Development builds keep their boards in a separate library (`%LOCALAPPDATA%\NovaLoomBoard (dev)`), so they never touch boards made with an installed copy.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the desktop app in development mode |
| `pnpm dev:web` | Runs only the interface in a browser (boards are not saved) |
| `pnpm test` | Runs the test suite (Vitest) |
| `pnpm typecheck` | Type-checks every package |
| `pnpm build` | Builds the interface and the Electron main process |
| `pnpm start` | Builds, then runs the production build without packaging |
| `pnpm package` | Builds a Windows installer into `apps/desktop/release/dist/` |

`pnpm package` also accepts `--dir` (an unpacked app only) and `--store` (a Microsoft Store package), for example `pnpm --filter @novaloom/desktop package -- --store`. See [docs/PACKAGING.md](docs/PACKAGING.md).

<details>
<summary>Troubleshooting</summary>

- **"Electron failed to install correctly"**: pnpm can skip Electron's download step. Run `node install.js` inside `node_modules/.pnpm/electron@*/node_modules/electron`, then try again.
- **The app quits as soon as it starts:** another copy of NovaLoomBoard is already running. Only one copy runs at a time.
- **Port 5173 is busy:** the dev script picks the port Vite actually opened, so this is harmless.

</details>

## Project structure

```
apps/
  desktop/          Electron main process, preload bridge and packaging scripts
  web/              The interface: React 19 + Vite
packages/
  board-engine/     Canvas rendering, tools, objects, history, export (framework-free TypeScript)
  board-store/      Board files on SQLite, the save journal, library and snapshots
assets/brand/       Logo, icons and wordmarks
docs/               Architecture, packaging and dependency notes
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together and why they're built this way.

## Board files

Boards are SQLite databases with the `.nlboard` extension, stored in `%LOCALAPPDATA%\NovaLoomBoard`. Use **File › Save a copy as** to keep a board anywhere else, and **File › Open** to open one. Each file holds its pages, objects and images, so a single file is a complete board.

## Contributing

Contributions are welcome: bug reports, ideas, documentation and code. See the [roadmap](ROADMAP.md) for where the project is heading and the [project board](https://github.com/users/ghaithheni/projects/1) for current work, then start with [CONTRIBUTING.md](CONTRIBUTING.md), and please follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

NovaLoomBoard is released under the [MIT License](LICENSE).

It builds on excellent open-source projects, including Electron, React, pdf.js, MathJax, perfect-freehand and Lucide. Their licences are listed in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md), and the full licence texts ship with the app in `THIRD_PARTY_NOTICES.txt`.
