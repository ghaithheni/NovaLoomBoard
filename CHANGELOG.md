# Changelog

All notable changes to NovaLoomBoard are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Improved
- Long strokes stay fast while you draw. Previously, the stroke being drawn was rebuilt and filled in full on every frame, so it slowed down as it grew; at about 6,000 points, frames took up to 33 ms. Now only its last few points are redrawn, and the rest is kept in a cache. In testing on a 240 Hz display, frames kept to the display's 4.2 ms at any stroke length. The live outline is exactly the one perfect-freehand computes.
- Saved strokes are drawn straight from their outline instead of an SVG path string, which skips formatting and parsing a string for every stroke.

### Fixed
- Long strokes had slightly wavy edges: in testing, the curve drifted by up to 1.2 units, wide enough to see on a thin pen. The outline path used SVG's shorthand curves, so rounding errors built up along the stroke. Strokes now follow their outline exactly on screen, and to within 0.01 units in exported PDFs.
- Saving board files on Node 22, which the board store supports from 22.13. The desktop app runs on Electron's built-in Node 24 and was not affected.
  - Opening a board file, or restoring an earlier version as a copy, failed with `NOT NULL constraint failed: objects.points` when the board contained shapes, text, images or equations.
  - On Node 22.13 and 22.14, board files were never closed (the check relied on `isOpen`, added in 22.15). Failed saves also weren't rolled back (`isTransaction` was added in 22.16).
- The tests now also run on Node 22.13.0 in continuous integration.

## [0.1.0] - 2026-11-25

First public release of the source code.

### Drawing and editing
- Pen, pencil and highlighter, with smoothing and pen pressure; shape recognition when you hold still after a stroke.
- Shapes: line, arrow, rectangle, ellipse, triangle, diamond, star, hexagon, speech bubble, check mark and cross, each solid, dashed or dotted.
- Wrapping text boxes, a stroke and partial eraser, a laser pointer, and ruler and protractor guides.
- Box and lasso selection; group, lock, align, distribute, rotate, duplicate; full undo and redo.

### Maths
- Function plotting from typed formulas, on a coordinate grid.
- Typeset equations (TeX and chemistry) with MathJax, editable after insertion.

### Boards and files
- Multiple pages with thumbnails; eight backgrounds on white, green or black boards.
- Continuous saving to SQLite board files (`.nlboard`), crash recovery and version history.
- Image and PDF import; PDF and PNG export; copy as image.

### Presenting
- Presentation mode, spotlight, screen shade, and a timer and stopwatch.

### App
- Light and dark interface, keyboard shortcuts on any keyboard layout, high-DPI and touch-friendly controls.
- Windows installer and Microsoft Store packaging, with a hardened Electron configuration.

[0.1.0]: https://github.com/ghaithheni/NovaLoomBoard/releases/tag/v0.1.0
