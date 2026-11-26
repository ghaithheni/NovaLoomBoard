# NovaLoomBoard roadmap

This document describes where NovaLoomBoard is going and why. It covers the product vision, the principles every change must respect, what gets built in which order, and the technical reasoning behind those choices.

It is a plan, not a promise. Effort estimates are rough, there are no dates, and phases move when we learn something new. Changes to this roadmap are discussed in public issues before they are made.

_Last reviewed: November 2026, at version 0.1.0._

## Contents

- [Vision](#vision)
- [Principles](#principles)
- [Where NovaLoomBoard is today](#where-novaloomboard-is-today)
- [Priorities](#priorities)
- [Release plan](#release-plan)
- [Technical investigations](#technical-investigations)
- [Not planned](#not-planned)
- [Competitive landscape](#competitive-landscape)
- [Taking part](#taking-part)
- [Sources](#sources)

## Vision

**NovaLoomBoard is the pen-first whiteboard you own.** It is a fast, beautiful canvas for anyone who thinks or explains by drawing: students, tutors, engineers, researchers, presenters and people sketching ideas alone. It works offline, keeps everything in ordinary files, and never asks for an account.

Three ideas, built on that foundation, should make it stand out:

- **Explaining, not just drawing.** Boards can be presented as zoomable journeys, and recorded with narration so the explanation can be replayed or exported as a video.
- **Mathematics that is alive.** Plots and equations are not pictures: they can be changed, explored and computed on the board.
- **Ink that feels right.** Low latency, accurate pressure and a calm interface that stays out of the way.

## Principles

These are non-negotiable. A feature that conflicts with one of them is not accepted, however attractive it is.

| Principle | What it means in practice |
| --- | --- |
| Open source and free | MIT licence. Every dependency uses a licence compatible with it. No paid tier, no feature held back. |
| Offline-first, no account | Every feature works with the network cable unplugged. Nothing asks you to sign in. |
| No mandatory cloud services | The app never depends on a server we run. Optional network features talk only to machines the user chooses. |
| No paid APIs or subscriptions | No feature relies on a paid service, including for recognition or AI features. |
| Privacy by design | No telemetry. Any network request, such as an update check, is opt-in, documented and does not identify the user. Microphone and other sensitive access is visibly indicated. |
| Modern, beautiful, intuitive | New features ship with a design that fits the app, or they don't ship. Simple things stay simple. |
| Excellent performance on modest hardware | Performance budgets are measured in automated tests, against a reference low-end machine. |
| Cross-platform ambitions | Windows first, then macOS and Linux. Platform-specific code stays behind small interfaces. |
| Extensible without unnecessary complexity | Clean package boundaries first. A plugin system comes only after the core is stable. |

Optional network features must never weaken the standalone offline experience: they are off by default, and the app behaves identically without them.

## Where NovaLoomBoard is today

Version 0.1.0 is a capable Windows whiteboard with an unusually solid foundation.

**Strengths**

- Smoothed, pressure-sensitive ink (perfect-freehand) with hold-still shape recognition.
- Shapes, text, images, ruler and protractor, lasso selection, grouping and alignment.
- Function plotting with a safe parser, and MathJax equations including chemistry.
- Presentation mode with laser pointer, spotlight, screen shade and timer.
- Multiple pages, vector PDF export, PDF import, version history.
- Crash-safe storage: each board is one SQLite file, written in atomic transactions and checked when opened.
- A hardened Electron setup (sandbox, context isolation, validated IPC, fuses) and 180 automated tests.
- A clean architecture: the board engine (`packages/board-engine`) knows nothing about Electron, and the storage layer (`packages/board-store`) knows nothing about the interface.

**Gaps**

- **No downloadable build.** The installer is unsigned and not attached to releases, so only developers can use the app.
- **Pen input is unverified on real hardware.** Pressure, latency and palm rejection have only been tested in software.
- **Windows only.** The window chrome uses Windows-specific caption buttons and fonts, and only Windows packages are built.
- **English only,** with no translation system and no right-to-left support.
- **Board content is invisible to assistive technology.** The interface controls are labelled, but objects on the canvas are not exposed to screen readers.
- **No connectors, frames or sticky notes.**
- **Performance at scale is unmeasured.** There is no benchmark for large boards.
- **Interoperability is limited.** Boards export to PDF and PNG only, and the file format is not documented.

## Priorities

Every proposed feature falls into one of three categories. Core experience comes first: differentiators built on a weak core will not keep users.

### Core experience

Features every excellent whiteboard needs. These are not optional.

| Feature | Why it matters |
| --- | --- |
| Signed, downloadable builds with update notifications | Without them, nobody outside the project can use the app safely. |
| Verified low-latency, pressure-accurate pen input | The pen is the product. If ink feels laggy, nothing else matters. |
| Smooth performance on large boards and modest hardware | Whiteboards grow. Slowdowns destroy trust. |
| macOS and Linux | Reaching users wherever they are. |
| Translations and right-to-left layouts | A global product must speak its users' languages. |
| Accessibility | Keyboard use, screen readers, high contrast and reduced motion. |
| Frames, connectors and sticky notes | Basic structure that users expect on any canvas. |
| Annotating PDFs and exporting the result | One of the most common reasons people pick up a pen on a computer. |
| SVG export and a documented file format | Users can take their work anywhere. |

### Differentiators

Features that could make NovaLoomBoard special. Each builds on core work, and each is scoped to be achievable.

| Feature | Why it is different |
| --- | --- |
| Zoomable presentations | Frames on an infinite canvas become a path the camera travels along, with a presenter view on a second screen. |
| Recording and replay | Explanations are recorded as board events plus narration, not as video. Recordings are small, sharp at any resolution, editable and replayable inside the app. |
| Video export | Any recording becomes a standard video file, rendered locally. |
| Live mathematics | Plots with parameter sliders, multiple functions, and computed results, all typed and offline. |
| Accessibility as a signature | Equations read aloud, alt text on every object, and an outline of the board for screen readers. Few whiteboards do this well. |

### Long-term possibilities

Ambitious features that are worth exploring but must not distract from the core product. Each needs a successful research spike before it gets a release slot.

| Possibility | Why it waits |
| --- | --- |
| Handwritten maths recognition | Open models exist, but they are large, and the main training datasets forbid commercial use. See [Offline mathematical recognition](#offline-mathematical-recognition). |
| Handwriting search | No open, offline, multilingual handwriting recogniser is mature enough. See [Handwriting search](#handwriting-search). |
| Local-network audience view | Valuable in rooms, but it adds a network server to a desktop app, with security implications. |
| Peer-to-peer or self-hosted collaboration | Real value for some users, but a major architectural change. Only after 1.0, and only if demand is clear. |
| Plugin system | Needs a stable engine API first. |
| Browser version | Feasible because the engine is separate, but needs a different storage backend. |
| Dynamic geometry | Constructions that keep their relationships when dragged. A large project in itself. |

## Release plan

Each release is one coherent phase with a clear objective. A phase is complete only when all its completion criteria are met.

**Effort scale.** Estimates assume one experienced contributor:

| Size | Effort |
| --- | --- |
| S | A few days |
| M | One to three weeks |
| L | One to two months |
| XL | Several months, or research needed first |

| Version | Phase | Objective |
| --- | --- | --- |
| 0.2 | Trustworthy release | Anyone on Windows can install, trust and enjoy the app |
| 0.3 | Everywhere | macOS and Linux, translations, accessibility, open format |
| 0.4 | Structure and PDF | Frames, connectors, sticky notes, PDF annotation |
| 0.5 | Present | Zoomable presentations and presenter view |
| 0.6 | Record | Recording, replay and narration |
| 0.7 | Share explanations | Video export |
| 0.8 | Live mathematics | Interactive plots and computed maths |
| 1.0 | Stable | Frozen file format, performance and accessibility commitments met |

**Reference machine.** Performance criteria refer to a deliberately modest computer: a four-core laptop processor from around 2018 with integrated graphics, 8 GB of memory and a 1080p display. Benchmarks are also run on whatever hardware contributors have, but this machine sets the bar.

The order follows dependencies, not excitement. Frames (0.4) are needed for presentations (0.5). Recording (0.6) is needed for video export (0.7). Cross-platform and translation work (0.3) is cheaper now, while the interface is small, than after more features are added.

---

### 0.2: Trustworthy release

**Objective:** a person who has never heard of the project can download NovaLoomBoard, install it without scary warnings, draw with a pen that feels good, and trust that it won't lose their work.

| Feature | Value | Complexity | Depends on |
| --- | --- | --- | --- |
| Signed Windows builds attached to GitHub releases | Removes SmartScreen warnings and makes the app installable by anyone | M | A signing route: SignPath Foundation (free for qualifying open-source projects) or the Microsoft Store (free registration for individuals) |
| Opt-in update check | Users learn about fixes. Off by default, with no identifying data sent | S | Signed builds |
| Pen latency and pressure pass | The pen feels immediate and natural | M | Hardware test devices (see [Low-latency pen input](#low-latency-pen-input-and-pressure)) |
| Pressure curve setting | Adapts to different pens and hands | S | Pen pass |
| Performance benchmark suite | Prevents slowdowns and guides optimisation | M | None |
| Pan and zoom optimisation | Large boards stay smooth | M | Benchmark |
| Local diagnostics log | Helps users report bugs, without telemetry | S | None |
| Contributor on-ramp | Labelled starter issues and a public roadmap board | S | This roadmap |

**Architectural risks**

- Low-latency rendering may require changing how the live stroke is drawn. This is confined to the renderer and engine, and does not affect the file format.
- An update check is the app's first network request. It must live in the main process, be off by default, and be easy to audit.

**Done when**

- Signed installers for every release are on GitHub, and installing on a clean Windows 10 and Windows 11 machine shows no unknown-publisher warning.
- Pen input has been tested on at least two pen devices from different vendors, using a written test protocol, with results published in `docs/`.
- The live stroke keeps up with the pen at 60 frames per second on the reference low-end machine, with a stroke of 2,000 points.
- The benchmark suite runs in the automated checks, and a 50,000-stroke board pans at 60 frames per second on the reference machine.
- At least ten labelled starter issues are open.

---

### 0.3: Everywhere

**Objective:** NovaLoomBoard runs on Windows, macOS and Linux, in several languages, and can be used with a keyboard and screen reader.

| Feature | Value | Complexity | Depends on |
| --- | --- | --- | --- |
| Platform abstraction for the window chrome | Native-feeling title bars and shortcuts on each platform (Cmd on macOS) | M | None |
| Linux builds (AppImage and Flatpak) | Reaches Linux users, including through Flathub | M | Platform abstraction |
| macOS builds | Reaches Mac users | M | Platform abstraction. Notarisation needs a paid Apple Developer membership, so unsigned builds come first (see [Cross-platform compatibility](#cross-platform-compatibility)) |
| Translation system | All interface text can be translated | M | None |
| Community translations | First languages, chosen by volunteer demand | S per language | Translation system, a translation platform (Hosted Weblate is free for libre projects) |
| Right-to-left layouts | Arabic, Hebrew, Persian and Urdu users get a correct interface and text | L | Translation system |
| Accessibility pass on the interface | Full keyboard use, focus order, high contrast (`forced-colors`), reduced motion | M | None |
| Accessible board outline | Screen readers can list and navigate objects; equations are read aloud | L | Accessibility pass |
| Alt text for images, equations and plots | Board content has text descriptions, also used in exported PDFs | S | None |
| SVG export | Vector output for other tools and the web | M | None |
| File format specification 1.0 draft | Others can read and write boards. Documents the SQLite schema and object encoding | M | None |

**Architectural risks**

- **Right-to-left text in the canvas.** The engine lays out board text itself (`text-layout.ts` and `text-editor.ts`). Mixed-direction text needs the Unicode bidirectional algorithm in both. This is the riskiest item in the phase and needs a design note before work starts.
- **An accessible mirror of the board** must stay in sync with the canvas without slowing down drawing. It should be updated from the same change batches that drive rendering, throttled, and only when assistive technology is in use.
- **Pen input on Linux.** Chromium's support for pen pressure under Wayland has to be tested; under X11 it is more established. If Wayland pressure is missing, document running under XWayland as a workaround.

**Done when**

- Builds for all three platforms come out of the automated pipeline, and each has been installed and used on real hardware.
- At least three languages besides English are complete, including one right-to-left language.
- Every interface control is reachable and usable by keyboard. An automated accessibility check (axe-core) passes on every dialog.
- A screen reader user can list the objects on a page and hear an equation read aloud.
- The file format specification is published in `docs/`, and a test reads every sample file using only the specification.

---

### 0.4: Structure and PDF

**Objective:** boards can be organised, and PDFs can be annotated and exported with their original quality.

| Feature | Value | Complexity | Depends on |
| --- | --- | --- | --- |
| Frames | Named regions that group content, used for export, navigation and presentations | M | None |
| Connectors that stay attached | Arrows follow objects when they move. Basic diagrams become possible | L | None |
| Sticky notes | Quick text blocks with a background colour | S | None |
| PDF annotation with original-quality export | Annotate a PDF and export it with the original vector text and pages, plus your ink | L | Original PDF stored in the board, a PDF-writing library (pdf-lib, MIT) |
| Templates | Start from layouts such as a weekly plan, Cornell notes or a storyboard | S | Frames |
| Creation times on objects | Enables build-up replay of any board, and prepares for recording | S | The recording design; shipped in the same schema change as frames and connectors, to avoid a second migration |

**Architectural risks**

- **Connectors create the first references between objects.** Today, every object stands alone, and an operation either adds or removes one whole object (`ops.ts`). A connector that points at a shape must survive undo, deletion of the shape, copy and paste, and pages. The rule must be decided before implementation: for example, a connector keeps a stored endpoint position so a dangling reference still draws correctly.
- **PDF import currently rasterises pages** into WebP images (`apps/web/src/pdfImport.ts`). To export the original quality, the source PDF must be kept in the board's assets table, and export must draw the ink over the original pages. Board files grow by the size of the PDF. This is acceptable, but users must be told.
- Each feature adds object types. This needs a file schema version bump, done once for the whole phase. Older versions of the app must refuse to open newer files gracefully, as they already do.

**Done when**

- Moving a shape moves the connectors attached to it, including after undo, redo, copy and paste.
- A 50-page PDF can be annotated and exported. The exported file keeps the original text selectable, and opens correctly in at least three PDF readers.
- Boards from 0.3 open unchanged, and the upgrade is covered by tests.

---

### 0.5: Present

**Objective:** a board can be presented as a journey through the canvas, comfortably, on one or two screens.

| Feature | Value | Complexity | Depends on |
| --- | --- | --- | --- |
| Presentation path | Frames, in an order you choose, become the steps of a presentation | M | Frames |
| Smooth camera transitions | The camera glides and zooms between frames, respecting reduced-motion settings | S | Presentation path |
| Presenter view | Notes, the next frame and a timer on a second screen, while the audience sees the board | L | Presentation path |
| Step-by-step reveals | Objects inside a frame can appear one by one | M | Presentation path |
| Draw while presenting | Ink on top of the presentation, optionally discarded at the end | S | None (laser and pen already work in presentation mode) |

**Architectural risks**

- **The presenter view needs a second window that shows the same board.** The engine is currently created once per window. The second window should receive a read-only stream of the same change batches, relayed by the main process, rather than reading the file. This is the same mechanism a local-network audience view or collaboration would need later, so it deserves careful design.

**Done when**

- A presentation with 20 frames runs smoothly at 60 frames per second on the reference machine.
- The presenter view works with a projector or second monitor on all three platforms.
- Presentations are stored in the board file and survive a round trip through the file format.

---

### 0.6: Record

**Objective:** explanations can be recorded on the board with optional narration, and replayed inside the app.

| Feature | Value | Complexity | Depends on |
| --- | --- | --- | --- |
| Recording timeline | A recording captures every change, stroke timing, camera movement, page change and laser pointer path | L | Schema version bump |
| Narration | Microphone audio recorded alongside, compressed with Opus | M | Recording timeline |
| Replay with seeking | Play, pause and scrub through a recording. Seeking is instant, even in long recordings | L | Recording timeline |
| Trimming | Cut the beginning, the end, or pauses | M | Replay |
| Build-up replay for any board | Animate how a board was built, using per-object creation times, even without a recording | S | Creation times on objects (0.4) |

**Architectural risks**

These are covered in detail in [Recording and replay](#recording-and-replay). In short:

- The board file stores only the current state, and the operation history exists only in memory. Recording is a new kind of data: an append-only timeline, stored in new tables.
- Stroke points currently carry position and pressure but not time. Recordings need point timing, which is stored in the timeline, not in the object.
- Narration makes board files much larger. A one-hour recording at 32 kbit/s is about 14 MB.

**Done when**

- A one-hour recording with narration replays in sync, with audio and drawing within 50 ms of each other throughout.
- Seeking to any point takes less than 200 ms on the reference machine.
- A recording survives a crash: everything up to the last few seconds is kept.
- Recording is clearly indicated on screen whenever the microphone is in use.

---

### 0.7: Share explanations

**Objective:** any recording can be exported as a standard video file, entirely on the user's machine.

| Feature | Value | Complexity | Depends on |
| --- | --- | --- | --- |
| Video export | WebM (VP9 and Opus) everywhere. MP4 (H.264 and AAC or Opus) where the platform supports it | L | Recording, a muxing library (Mediabunny, MPL-2.0) |
| Export settings | Resolution, frame rate, aspect ratio, and which frame or region the camera follows | M | Video export |
| Captions file | A subtitle track from the user's own text notes, never from cloud transcription | S | Video export |

**Architectural risks**

- **Codec availability varies by platform and build.** Every codec must be checked at run time with `VideoEncoder.isConfigSupported()`. VP9 in WebM is the guaranteed fallback.
- **Long exports must stream to disk.** Encoded chunks go to the main process and are written to the file as they are produced, so memory stays flat.
- **Mediabunny is MPL-2.0.** This is compatible with distributing an MIT app, as long as Mediabunny's own files are used unmodified or any changes to them are published. Its licence text must be added to the third-party notices.

**Done when**

- A 30-minute recording exports to 1080p video in less than its real-time duration on the reference machine, with flat memory use.
- Exported files play in VLC, the default players on all three platforms, and a web browser.

---

### 0.8: Live mathematics

**Objective:** mathematics on the board is interactive and computable, using typed input first.

| Feature | Value | Complexity | Depends on |
| --- | --- | --- | --- |
| Parameters and sliders | `y = a·sin(b·x)` with draggable sliders for `a` and `b` | M | Extends the existing plot parser (`plot.ts`) |
| Several functions on one graph | Compare curves, with a legend | M | None |
| Points, intersections and tangents | Mark and compute key points on graphs | M | Several functions |
| Editable plots | Plots stay live objects, not images, and can be changed later | M | Schema version bump |
| Computed results | Evaluate expressions and show results on the board, offline | M | A computation engine. The candidates must be evaluated for licence, size and accuracy, or the existing parser extended |
| Tables of values | Generate a table from a function | S | None |

**Architectural risks**

- **Plots become objects with parameters.** Today, a plot is drawn once. Live plots need their own object type, redrawn when parameters change. They are also needed in PDF and SVG export and in recordings.
- **The parser must stay safe.** Any extension must keep the current guarantee that user input is never run as code.

**Done when**

- A plot with three parameters redraws within one frame while a slider is dragged on the reference machine.
- Live plots export correctly to PDF, SVG and video.
- The parser passes a fuzzing test with no crashes and no code execution.

---

### 1.0: Stable

**Objective:** a release people can rely on for years.

| Commitment | Criteria |
| --- | --- |
| Stable file format | Specification 1.0 frozen. Every future version opens 1.0 files, and this is enforced by tests with archived sample files. |
| Performance budgets | All benchmarks pass on the reference machine on all three platforms. |
| Accessibility | The interface meets WCAG 2.2 level AA where applicable, assessed with a published checklist. |
| Translations | At least five complete languages besides English. |
| Documentation | User guide, file format specification, architecture guide and contribution guide are complete and current. |
| Security | An external review of the IPC boundary and file parsing, or a public audit checklist completed by maintainers. |

---

## Technical investigations

This section tests the most ambitious ideas against reality. Each investigation describes what the code does today, what is feasible, the chosen approach, and what was rejected.

### Low-latency pen input and pressure

**Today.** The engine already uses coalesced pointer events (`getCoalescedEvents`), so it receives every pen sample, not just one per frame. It renders on two canvas layers: a static layer for committed content and an active layer for the stroke being drawn. Pressure comes from `PointerEvent.pressure` for pens and is simulated for mouse and touch. Touch is ignored for drawing once a pen has been seen, which is a simple form of palm rejection.

Two things limit latency:

- The live stroke's outline is recomputed from all its points on every frame (`renderer.ts`), so long strokes get slower as they grow.
- Every frame goes through the browser's normal compositing pipeline, which adds at least one frame of delay compared with native ink.

**Feasible improvements, in order of value:**

1. **Incremental live stroke.** Render the settled part of the stroke once, and recompute only the last few points each frame. This removes the slowdown on long strokes. Complexity S to M.
2. **Delegated ink trail** (`navigator.ink.requestPresenter`). Supported in Chromium since version 94. The operating system's compositor draws the newest part of the stroke ahead of the app's own rendering. On Windows 11, Microsoft describes this as using a Windows compositor API. This is the most promising latency reduction, and it is a standard web API, so it needs no native code. Complexity M.
3. **Predicted events** (`getPredictedEvents`). Supported in Chromium since version 77. Drawing a short predicted tail, replaced on the next frame, hides some remaining latency. It must be tuned carefully, because bad prediction is worse than none. Complexity S.
4. **The `desynchronized` canvas hint.** Chrome documents it as reducing latency by bypassing parts of the compositor for the 2D and WebGL contexts. The effect depends on the platform and must be measured. Complexity S.

**Measurement.** Latency is measured in two ways:

- In the app, from event timestamp to frame presentation.
- Physically, with a high-speed phone camera filming the pen tip and the drawn line. This is the only way to measure what users actually feel.

**Pressure.** Pen pressure depends on the driver. With some tablets, pressure reaches Chromium only when the driver's Windows Ink setting is enabled. This is documented for users, not worked around in code. A pressure curve setting adapts the response to different pens.

**Rejected: native ink rendering through a Node addon.** It could reach the lowest latency on Windows, but it would bring native code, a per-platform implementation and a split between native and web rendering. The delegated ink trail delivers most of the benefit through a standard API.

### Recording and replay

**The idea, tested.** The earlier assumption was that replay could reuse "the existing operation history". It can only partly:

- The engine's operations (`ops.ts`) are exactly the right shape for replay. Each batch adds or removes whole objects, is deterministic and can be inverted.
- But that history lives only in memory, for undo. The board file stores the current state; journal entries are applied and then discarded (`board-file.ts`, `journal.ts`). Version history keeps full copies every few minutes, which is far too coarse for replay.
- Stroke points carry position and pressure but no timestamps, so even a complete operation log could not show a stroke being drawn at the speed it was drawn.

So existing boards cannot be replayed. Recording has to be designed as a new kind of data.

**Chosen approach**

- **Recording is explicit.** The user presses Record. An always-on log would make every board grow forever, and would record people who never asked for it.
- **The timeline is stored inside the board file**, in new tables added by a schema version bump. The board stays one self-contained file. It records:
  - the change batches, as they are already produced for undo;
  - point timings for strokes drawn during the recording;
  - camera movements, page changes, and laser pointer and spotlight paths, which are not board changes today and must be captured separately.
- **Keyframes make seeking instant.** Every 30 seconds or so, the timeline stores a compact snapshot of page state. Seeking replays at most 30 seconds of events from the nearest keyframe.
- **Narration is stored as Opus audio** in chunks of a few seconds, with timestamps from the same clock as the board events. Chunks are written as they are recorded, so a crash loses only the last few seconds.
- **Replay applies the recorded batches to a separate copy of the board.** The user's board is never touched by replay.

**Why this beats screen recording:**

- A recording is small: a long explanation is mostly small vector changes plus compressed audio.
- It is sharp at any resolution, including on a 4K display or when zoomed in.
- It is editable: trimming changes the timeline, not pixels.
- It can be exported to video at any resolution, later.

**A cheaper first step.** Storing a creation time on each object enables a build-up replay of any board created after that change. Objects appear in the order they were made, and strokes are drawn along their points at a steady speed. Deleted objects don't appear, which is acceptable for this purpose. This is a small, additive change (S), and it can ship before full recording.

**Risks**

- **The recording and the live board can diverge.** If the user keeps editing after recording, the recording still describes what happened during the recording, which is correct. The interface must make this clear.
- **File size.** This is dominated by audio. It is shown in the interface, with an option to remove the narration or the whole recording.
- **Privacy.** A clear recording indicator, and microphone permission requested only when narration is turned on.

### Video export and audio narration

**Feasible, with standard web APIs and no native code:**

- **Rendering:** the existing renderer draws frames of the replay to an offscreen canvas, at a fixed frame rate, as fast as the machine allows. This is independent of real time.
- **Encoding:** WebCodecs (`VideoEncoder`, `AudioEncoder`) in Chromium. Hardware encoders are used where available.
- **Muxing:** Mediabunny (MPL-2.0) writes WebM and MP4 files. The older `mp4-muxer` and `webm-muxer` libraries by the same author are deprecated in its favour.
- **Audio capture:** `getUserMedia` and `MediaRecorder` with Opus, or `AudioEncoder` directly.

**Codecs.** The WebCodecs specification does not require H.264. Whether an Electron build can encode it depends on how Chromium was built and on the platform, so every codec is checked at run time. VP9 in WebM is the guaranteed baseline. H.264 in MP4 is offered when available, because some platforms and services prefer it.

**Rejected: bundling FFmpeg.** It would add a large binary, licensing questions for some codecs, and a native build per platform, for little gain over WebCodecs.

### Offline mathematical recognition

**What exists:**

- **TexTeller** is an open model that converts images of formulas, including handwritten ones, to LaTeX. Its model card lists the Apache-2.0 licence, and it is listed at about 298 million parameters. That is too heavy to ship by default for modest hardware, and it works from images, not from pen strokes.
- **Training data is the real obstacle.** The two best-known handwritten maths datasets forbid commercial use:
  - The CROHME competition data is provided under a Creative Commons licence for academic and research purposes only.
  - Google's MathWriting dataset is CC BY-NC-SA 4.0.

  A model trained on them could not clearly be redistributed with an MIT app that anyone may use commercially.
- Stroke-based recognition, which would use the timing and order of strokes the app already has, is an active research area. We found no mature, permissively licensed, lightweight stroke-based model.

**Conclusion.** Handwritten maths recognition is a long-term possibility, not a planned feature. The 0.8 phase delivers live mathematics through typed input, which is where most of the value is: interactive plots, sliders and computation.

**Path, if it happens:**

- A research spike evaluating accuracy, size and licence of available models, including their training data.
- An optional, separately downloaded model pack, run with ONNX Runtime (MIT), never bundled by default.
- Recognition always suggests and never replaces: the user confirms the result.

### Handwriting search

**What exists:**

- Windows includes a handwriting recogniser for apps (the Windows Ink recognition APIs), driven by installed language packs. Using it from Electron would need a small native bridge, and it exists only on Windows.
- Open-source handwriting recognisers are mostly language-specific, research-grade, or under non-commercial licences. We found none that is offline, multilingual, permissively licensed and mature.

**Conclusion.** Handwriting search is a long-term possibility. The first step is cheap and valuable: search across board names, page names, typed text, equation sources and alt text, using SQLite's built-in full-text search. This belongs in the core experience once boards have alt text (0.3).

Recognition can come later through the same optional interface as maths recognition: per platform where the operating system offers a recogniser, or through a downloadable model pack.

### Infinite canvas performance

**Today:**

- Two canvas layers, redrawn only when marked dirty, in a single animation frame callback.
- Objects are culled against the visible area with an R-tree spatial index (rbush). Only visible objects are drawn.
- Stroke outlines are cached as `Path2D` objects, so they aren't recomputed on every frame.

**Where it will break:**

- **Zoomed out, every object is visible**, so culling stops helping and every cached path is drawn on every frame of a pan or zoom.
- **One `Path2D` per stroke** uses memory proportional to the whole board.
- **The static layer is fully redrawn on every frame of a pan.**

**Planned improvements, in order:**

1. **Measure first.** Benchmark boards with 10,000, 50,000 and 200,000 strokes; record frame times while panning and zooming, opening time and memory.
2. **Reuse pixels while panning.** Shift the previous frame and draw only the newly exposed strips; redraw fully when the movement stops. This is a large gain for little code.
3. **Level of detail.** Skip strokes smaller than a pixel on screen. Draw simplified polylines instead of full outlines when zoomed far out.
4. **Bitmap tiles** at a few fixed zoom levels, invalidated by object bounds. More complex; only if steps 2 and 3 are not enough.

**Rejected for now: a WebGL or WebGPU renderer.** It could raise the ceiling, but it would mean rewriting the renderer, re-implementing text, images and dashed lines, and losing the simplicity of the 2D canvas. The renderer is already isolated behind a small interface, so this stays possible if measurements ever demand it.

### Cross-platform compatibility

**What already works everywhere:** Electron, React, the board engine, and storage through Node's built-in `node:sqlite`, which needs no native module to compile.

**What needs work:**

- **Window chrome.** The window hides the system title bar and draws Windows-style caption buttons with the Segoe Fluent Icons font. macOS needs its own window controls, and Linux needs a choice between native decorations and a portable design.
- **Keyboard shortcuts.** Cmd instead of Ctrl on macOS, and the platform's own conventions for full screen and preferences. The shortcut system already handles keyboard layouts, which helps.
- **Fonts.** The interface uses Segoe UI Variable, which exists only on Windows. It needs a system font stack.
- **Packaging.**
  - Linux: AppImage and Flatpak, through electron-builder.
  - macOS: a disk image. Apple's notarisation requires a paid Apple Developer Program membership, which conflicts with the project's no-cost approach.
  - Unsigned Mac apps still run, but since macOS Sequoia the user must allow them in System Settings › Privacy & Security, because the Control-click shortcut was removed. The first macOS releases ship unsigned with clear instructions. Notarisation is reconsidered if a sponsor covers the fee.
- **Pen input.** Pressure works through standard pointer events on all platforms. Linux under Wayland has a history of pens being reported as mice without pressure, so it needs testing on current compositors.

## Not planned

Saying no keeps the product focused. These are out of scope, and proposals for them will be closed with a link to this section.

- **Accounts, cloud storage or sync services run by the project.** Boards are files. Users can sync them with any tool they already use.
- **Telemetry or analytics** of any kind.
- **Features that need paid APIs**, including cloud handwriting recognition, transcription or AI services.
- **Real-time internet collaboration as a core feature.** It needs servers and accounts, and it is the most crowded part of the whiteboard market. Peer-to-peer or self-hosted collaboration remains a long-term possibility.
- **Native mobile apps.** Electron does not run on phones or tablets. A future browser version may cover tablets.
- **Teaching-platform features** such as classes, assignments or grading. NovaLoomBoard is a general tool; such features belong in plugins or other products.
- **A renderer rewrite** without measurements that justify it.

## Competitive landscape

Established alternatives are strong in their own areas. The opportunity is the combination that none of them offers: a polished, pen-first, offline canvas with presentation, recording and mathematics, under a permissive licence.

| Product | Strengths | Licence and model | Opportunity for NovaLoomBoard |
| --- | --- | --- | --- |
| [Excalidraw](https://github.com/excalidraw/excalidraw) | Very popular hand-drawn-style diagrams, end-to-end encrypted collaboration | MIT | Excalidraw focuses on diagrams drawn with mouse and keyboard; collaboration needs a relay server. NovaLoomBoard focuses on pen input, presenting and maths, offline |
| [tldraw](https://tldraw.dev) | Excellent canvas toolkit for developers | Source-available. Production use needs a licence key, and a "made with tldraw" watermark unless a business licence is bought | NovaLoomBoard is a finished app under MIT, with no licence keys |
| [Xournal++](https://github.com/xournalpp/xournalpp) | Mature handwriting and PDF annotation | GPL-2.0 | Paper-like pages rather than an infinite canvas; NovaLoomBoard adds presenting, recording and live maths |
| [OpenBoard](https://github.com/OpenBoard-org/OpenBoard) | Interactive whiteboard built for classrooms | GPL-3.0 | NovaLoomBoard serves everyone, not just classrooms, with a modern interface |
| [Rnote](https://github.com/flxzt/rnote) | Polished handwriting app for Linux | GPL-3.0-or-later | Rnote is centred on Linux and GNOME; NovaLoomBoard targets all three desktop platforms |
| [Saber](https://github.com/saber-notes/saber) | Cross-platform handwritten notes, including mobile, with optional sync | GPL-3.0 | Note-taking focused; NovaLoomBoard focuses on explaining and presenting |
| [Lorien](https://github.com/mbrlabs/Lorien) | Lightweight infinite canvas for sketching | MIT | Minimal feature set; its development status is unclear |
| [AFFiNE](https://github.com/toeverything/affine) | Documents and an "edgeless" whiteboard in one workspace, local-first | Open source editor with a source-available backend; check its repository for current terms | A broad workspace; NovaLoomBoard stays a focused, fast pen canvas |
| [Microsoft Whiteboard](https://support.microsoft.com/en-us/whiteboard/sign-up-for-a-new-whiteboard-account) | Polished, integrated with Microsoft 365 | Proprietary, free, requires signing in with a Microsoft account; real-time collaboration requires Microsoft 365 commercial accounts | No account, open files, works fully offline |

Licences and features change. If you spot an inaccuracy, please open an issue.

## Taking part

- **Follow the work:** the public [project board](https://github.com/users/ghaithheni/projects/1) shows what is up next, in progress and done. Each release also has a [milestone](https://github.com/ghaithheni/NovaLoomBoard/milestones) listing its issues.
- **Pick up work:** issues labelled [`good first issue`](https://github.com/ghaithheni/NovaLoomBoard/labels/good%20first%20issue) are scoped for newcomers. Issues labelled [`help wanted`](https://github.com/ghaithheni/NovaLoomBoard/labels/help%20wanted) are ready for anyone.
- **Discuss the roadmap:** open an issue with the Feature request template. Describe the problem before the solution, and say which category it belongs to: core, differentiator or long-term.
- **Translate:** once the translation system lands (0.3), translations will be open to everyone.
- **Test on your hardware:** pen and touch reports from real devices are among the most valuable contributions. The test protocol will be in `docs/` from 0.2.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the project and send changes.

## Sources

Claims about third-party projects, platforms and libraries in this document were checked against these sources in November 2026.

- Delegated ink trail: [MDN, Ink API](https://developer.mozilla.org/en-US/docs/Web/API/Ink_API); [Microsoft Edge blog on web ink enhancement](https://blogs.windows.com/msedgedev/?p=24844); [Can I use: DelegatedInkTrailPresenter](https://caniuse.com/mdn-api_delegatedinktrailpresenter)
- Predicted pointer events: [MDN, getPredictedEvents()](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getPredictedEvents)
- Desynchronized canvas: [Chrome for Developers, low-latency rendering with the desynchronized hint](https://developer.chrome.com/blog/desynchronized)
- WebCodecs and H.264: [MDN, WebCodecs codec selection](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Codec_selection); [W3C AVC (H.264) WebCodecs registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/)
- Mediabunny: [repository](https://github.com/Vanilagy/mediabunny); [mp4-muxer deprecation notice](https://github.com/Vanilagy/mp4-muxer)
- TexTeller: [model card](https://huggingface.co/OleehyO/TexTeller); [paper](https://arxiv.org/abs/2508.09220v1)
- MathWriting dataset: [paper](https://arxiv.org/abs/2404.10690)
- CROHME data: [official data page](https://www.isical.ac.in/~crohme/CROHME_data.html)
- Windows handwriting recognition: [Microsoft Learn, convert ink to text](https://learn.microsoft.com/en-us/windows/uwp/design/input/convert-ink-to-text)
- Wayland pen input in browsers: [Mozilla bug 1606832](https://bugzilla.mozilla.org/show_bug.cgi?id=1606832)
- macOS Gatekeeper changes: [MacRumors](https://www.macrumors.com/2024/08/06/macos-sequoia-gatekeeper-security-change/); [AppleInsider](https://appleinsider.com/articles/24/08/06/apple-removes-control-click-option-for-skipping-gatekeeper-in-macos-sequoia)
- Apple Developer Program fee and free Microsoft Store registration for individuals: [Windows Developer blog](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/); [Windows Central](https://www.windowscentral.com/microsoft/windows-11/microsoft-store-drops-fees-for-individual-developers-apple-still-charges-usd99-per-year)
- SignPath Foundation: [signpath.org](https://signpath.org/); [conditions](https://signpath.org/terms)
- Hosted Weblate: [hosting plans](https://weblate.org/hosting/)
- tldraw licence: [tldraw SDK licence](https://tldraw.dev/legal/tldraw-license); [licence key documentation](https://tldraw.dev/sdk-features/license-key)
- Excalidraw: [repository](https://github.com/excalidraw/excalidraw)
- Xournal++: [Debian copyright file](https://sources.debian.org/src/xournalpp/1.3.3-1/debian/copyright)
- OpenBoard: [Wikipedia](https://wikiwand.com/en/articles/OpenBoard)
- Rnote: [repository](https://github.com/flxzt/rnote)
- Saber: [repository](https://github.com/saber-notes/saber); [Arch Linux wiki](https://wiki.archlinux.org/title/Saber)
- Lorien: [repository](https://github.com/mbrlabs/Lorien); [AlternativeTo](https://alternativeto.net/software/lorien/about)
- AFFiNE: [repository](https://github.com/toeverything/affine); [pricing page](https://affine.pro/de/pricing)
- Microsoft Whiteboard: [sign-in requirements](https://support.microsoft.com/en-us/whiteboard/sign-into-the-whiteboard-mobile-app); [collaboration requirements](https://learn.microsoft.com/surface-hub/whiteboard-collaboration)
