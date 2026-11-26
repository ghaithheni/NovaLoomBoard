# Changelog

All notable changes to NovaLoomBoard are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
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
