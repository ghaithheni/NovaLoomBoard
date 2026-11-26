# NovaLoomBoard: GitHub organisation proposal

**Status: approved in November 2026, with the changes listed in [Approved changes](#approved-changes) at the end.** The original proposal is preserved unchanged below that note. Where the two differ, the approved changes apply.

## 1. Milestones

Create only the next three now. Later milestones are created when the previous one is nearly done, so the issue tracker never fills with stale plans. Each milestone description links to the matching section of ROADMAP.md and repeats its completion criteria.

| Milestone | Description |
| --- | --- |
| 0.2: Trustworthy release | Signed downloads, verified pen input, performance baseline |
| 0.3: Everywhere | macOS and Linux, translations, accessibility, SVG export, file format spec |
| 0.4: Structure and PDF | Frames, connectors, sticky notes, PDF annotation |

No "Backlog" milestone: issues without a milestone are the backlog.

## 2. Labels

Twenty labels in four groups. GitHub's defaults (`duplicate`, `invalid`, `question`, `wontfix`, `enhancement`) are replaced by these. `good first issue` and `help wanted` keep their exact names, because GitHub features them on its contributor pages.

**Type (exactly one per issue)**

| Label | Colour | Use |
| --- | --- | --- |
| `bug` | red | Something works incorrectly |
| `feature` | indigo | New capability from the roadmap |
| `improvement` | teal | Better behaviour of something that exists |
| `performance` | amber | Speed or memory |
| `docs` | grey | Documentation only |
| `research` | purple | A spike that ends in a written conclusion, not shipped code |

**Area (one or more)**

`area: ink`, `area: canvas`, `area: objects`, `area: math`, `area: presentation`, `area: storage`, `area: pdf`, `area: packaging`, `area: platform`, `area: accessibility`, `area: i18n`

**Status**

| Label | Use |
| --- | --- |
| `needs triage` | New and not yet reviewed (added automatically by the issue templates) |
| `needs design` | Agreed in principle, but needs a design note before code |
| `blocked` | Waiting on another issue or a decision |

**Contributors**

`good first issue`, `help wanted`

Priority is expressed by milestones and by the roadmap categories, not by labels.

## 3. Public contribution roadmap

- A **GitHub Project** (free) called "NovaLoomBoard roadmap", public, with a board view: Up next / In progress / In review / Done. Its views are grouped by milestone. ROADMAP.md links to it.
- ROADMAP.md stays the source of truth for direction; the Project shows the live state of the work.
- **Optional decision:** turn on GitHub Discussions with two categories ("Ideas" and "Q&A"), so open-ended ideas don't clutter issues. Discussions are currently off. I recommend turning them on once there are outside users; until then, issues are enough.

## 4. Issues

Sixteen issues in total: ten for 0.2, four seeds for 0.3, plus the good first issues counted separately below. Each has a scope and acceptance criteria.

### Milestone 0.2

**1. Choose and set up Windows code signing**
Labels: `research`, `area: packaging`

Scope: compare SignPath Foundation, which is free for qualifying open-source projects (the publisher shown is "SignPath Foundation", and it requires multi-factor authentication and fully automated builds), with Microsoft Store distribution (free registration for individuals, and the Store signs packages). Decide which to use first.

Acceptance criteria:
- A short decision note in `docs/PACKAGING.md`, covering the publisher name users will see, the requirements and the maintenance cost.
- The maintainer has approved the choice. This needs your decision and your accounts.

**2. Publish signed installers from a release workflow**
Labels: `feature`, `area: packaging`. Blocked by #1.

Scope: a GitHub Actions workflow, triggered by a version tag, that builds, signs and attaches the installer and a SHA-256 checksum to the GitHub release.

Acceptance criteria:
- Pushing a tag produces a release with the installer and checksums, with no manual steps.
- The installer shows the expected publisher on a clean Windows 11 machine, with no unknown-publisher warning.
- `docs/PACKAGING.md` describes the release process.

**3. Pen and touch test protocol, and first hardware results**
Labels: `research`, `area: ink`, `help wanted`

Scope: a written protocol covering pressure range, tilt, the eraser end, barrel buttons, palm rejection, touch gestures, and latency measured with a high-speed phone camera. Run it on at least two devices from different vendors.

Acceptance criteria:
- `docs/testing/pen-protocol.md` exists, with a results table per device.
- Every defect found is filed as its own issue.

**4. Draw the live stroke incrementally**
Labels: `performance`, `area: ink`

Scope: the stroke being drawn is currently recomputed from all its points every frame. Cache the settled part, and recompute only the tail.

Acceptance criteria:
- The time to draw a frame no longer grows with stroke length: a stroke of 2,000 points draws within the same frame budget as one of 100 points, measured by the benchmark suite (#7).
- The committed stroke is identical to the one drawn today, checked by comparing pixels in tests.

**5. Prototype the delegated ink trail and predicted events**
Labels: `research`, `area: ink`. Depends on #3 for measurement.

Scope: try `navigator.ink.requestPresenter` and `getPredictedEvents` behind a developer setting, and measure their effect on latency.

Acceptance criteria:
- Before-and-after latency measurements using the protocol from #3.
- A written recommendation to ship, tune or drop each technique.
- No change in behaviour when the setting is off.

**6. Pressure curve setting**
Labels: `feature`, `area: ink`

Scope: a setting with three or four presets, from soft to firm, that maps pen pressure to stroke width.

Acceptance criteria:
- The preset changes stroke width for new strokes only, never for existing ones.
- The setting persists between sessions.
- Engine tests cover the mapping.

**7. Benchmark suite for large boards**
Labels: `performance`, `area: canvas`

Scope: generated boards with 10,000, 50,000 and 200,000 strokes. Measure opening time, frame time while panning and zooming, and memory. Run the engine-level benchmarks in the automated checks.

Acceptance criteria:
- `pnpm bench` runs the suite and prints a results table.
- The automated checks fail if a tracked engine benchmark regresses by more than an agreed threshold.
- The current baseline numbers are recorded in `docs/`.

**8. Reuse pixels while panning**
Labels: `performance`, `area: canvas`. Depends on #7.

Scope: while panning, shift the previous frame and draw only the newly exposed strips; redraw fully when panning stops.

Acceptance criteria:
- Panning the 50,000-stroke benchmark board meets 60 frames per second on the reference machine.
- No visible seams or artefacts at any zoom level, or on high-DPI displays.

**9. Opt-in update check**
Labels: `feature`, `area: packaging`. Depends on #2.

Scope: when the user turns it on, check GitHub's releases API at most once a day and show a calm notice when a newer version exists. It never downloads or installs anything automatically.

Acceptance criteria:
- Off by default. With it off, the app makes no network requests at all, verified by a test.
- The request carries no identifying data beyond what any HTTPS request contains.
- `SECURITY.md` and `README.md` describe exactly what is sent.

**10. Local diagnostics for bug reports**
Labels: `improvement`, `area: platform`

Scope: a local rotating log of errors and warnings, plus a "Copy diagnostics" command that copies the app version, operating system and recent errors for pasting into a bug report.

Acceptance criteria:
- Nothing is ever sent anywhere.
- The copied text contains no board content and no file paths that reveal the user's name.
- The bug report template asks for it.

### Milestone 0.3 (seeds)

**11. Design note: platform abstraction for window chrome and shortcuts**
Labels: `research`, `area: platform`, `needs design`

Scope: how the title bar, caption buttons, fonts and Ctrl/Cmd shortcuts adapt to Windows, macOS and Linux.

Acceptance criteria:
- A design note in `docs/` that the maintainer has approved.
- Mock-ups for all three platforms.

**12. Translation system**
Labels: `feature`, `area: i18n`

Scope: choose a translation library (for example i18next, MIT), move all interface text into English message files, and support plurals and right-to-left direction flags.

Acceptance criteria:
- No user-visible strings remain hard-coded in components, checked by a lint rule.
- Switching to a test pseudo-language shows every string translated.
- The message format is supported by Hosted Weblate.

**13. SVG export**
Labels: `feature`, `area: objects`

Scope: export a page, or a selection, as SVG, including ink, shapes, text, images and equations.

Acceptance criteria:
- The output opens correctly in Inkscape and in two browsers.
- Text stays text, and equations stay vector.
- Tests compare the output against reference files.

**14. File format specification draft**
Labels: `docs`, `area: storage`

Scope: document the SQLite schema, object encoding, point encoding, asset storage, versioning and the compatibility promise.

Acceptance criteria:
- `docs/FILE-FORMAT.md` is published.
- A test parses the sample boards using only logic described in the specification.

### Good first issues

Small, self-contained tasks that a newcomer can finish in a day or two, each with a pointer to the files involved.

**GFI-1. Use a cross-platform system font stack**
Labels: `good first issue`, `improvement`, `area: platform`

Acceptance criteria:
- The interface falls back to the platform's own font on macOS and Linux.
- The appearance on Windows is unchanged, shown with before-and-after screenshots.

**GFI-2. Support Windows high-contrast mode in the toolbar**
Labels: `good first issue`, `area: accessibility`

Acceptance criteria:
- With a Windows contrast theme on, every toolbar button, its selected state and its focus ring are visible, using `forced-colors` styles.
- Screenshots are included.

**GFI-3. Respect reduced motion**
Labels: `good first issue`, `area: accessibility`

Acceptance criteria:
- With the system's reduced-motion setting on, the interface makes no non-essential animations.
- Every animation that was changed is listed in the pull request.

**GFI-4. Script to generate large sample boards**
Labels: `good first issue`, `performance`

Acceptance criteria:
- `node scripts/generate-board.mjs --strokes 50000 out.nlboard` creates a valid board that the app opens.
- The output is the same for the same seed.
- This script feeds #7.

**GFI-5. Generate a keyboard shortcuts reference**
Labels: `good first issue`, `docs`

Acceptance criteria:
- `docs/SHORTCUTS.md` is generated from the shortcut definitions in `apps/web/src/keys.ts` by a script.
- A test fails if the file is out of date.

## 5. What I'd do after approval

1. Replace the default labels with the set above.
2. Create the three milestones.
3. Create the sixteen issues and five good first issues, assign them to milestones, and add them to the public Project.
4. Add a "Roadmap" link to the repository's About links, and to the Project.

All of this is reversible, apart from issue numbers.

Decisions needed from you:
- the label set;
- the issue list;
- whether to turn on Discussions;
- the signing route in issue #1, later.

## Approved changes

The proposal was approved in November 2026, with these decisions and adjustments. This section records what was actually created.

### Decisions

- **Discussions stay off** until the project attracts outside users and contributors.
- **No signing route is chosen yet.** Issue #1 tracks the decision. The options are compared in [windows-signing-comparison.md](windows-signing-comparison.md).
- **Two priorities get particular attention:** the pen experience (#3, #4, #5, #6) and recording and replay (#19, with #18 preparing the file format). Neither is to be implemented before its design and measurements are done.

### Labels: what changed from the proposal

- **`blocked` was dropped.** GitHub's built-in issue dependencies ("blocked by") show the same information, with links.
- **`area: accessibility` and `area: i18n` became plain `accessibility` and `i18n`.** They are cross-cutting concerns rather than code areas, and an `accessibility` label already existed in the repository.
- **Renamed:** `enhancement` became `feature`, and `documentation` became `docs`.
- **Deleted:** `duplicate`, `invalid`, `question` and `wontfix`. GitHub's own close reasons ("duplicate", "not planned") cover them.
- **Issue templates:** both now add `needs triage`.

Final set (21 labels):

| Group | Labels |
| --- | --- |
| Type | `bug`, `feature`, `improvement`, `performance`, `docs`, `research` |
| Area | `area: ink`, `area: canvas`, `area: objects`, `area: math`, `area: presentation`, `area: storage`, `area: pdf`, `area: packaging`, `area: platform` |
| Cross-cutting | `accessibility`, `i18n` |
| Status | `needs triage`, `needs design` |
| Contributors | `good first issue`, `help wanted` |

### Issues: what changed from the proposal

- **0.4 issues were added**, as approved: #15 (design note on object references), #16 (frames), #17 (annotated PDF export with the original pages) and #18 (creation times on objects).
- **#18 is a deliberate addition.** Milestone 0.4 already changes the file schema, so adding the field recording needs at the same time avoids a second migration.
- **#19 designs the recording architecture.** It has no milestone, because recording is planned for 0.6, but the design should start early.
- **Good first issues were checked against the code.**
  - Two proposed tasks turned out to be already done: the font stack already falls back to `system-ui`, and the CSS already honours reduced motion. They were replaced with genuine gaps: PDF document titles (#20) and a colour contrast audit (#22).
  - The sample board generator (#24) and the shortcuts reference (#23) were adjusted. The workspace packages use extensionless TypeScript imports, so plain Node can't run them directly; #24 bundles with esbuild instead, and #23 generates the file from a Vitest test.
- Good first issues are assigned to the milestone they support.

### Created

| # | Issue | Milestone |
| --- | --- | --- |
| 1 | Decide the Windows distribution channel and signing route | 0.2 |
| 2 | Build and publish release installers from a tag workflow (blocked by #1) | 0.2 |
| 3 | Pen and touch test protocol, with results from real hardware | 0.2 |
| 4 | Draw the live stroke incrementally so long strokes stay fast | 0.2 |
| 5 | Prototype the delegated ink trail and predicted pointer events (blocked by #3) | 0.2 |
| 6 | Add a pressure response setting for pens | 0.2 |
| 7 | Benchmark suite for large boards | 0.2 |
| 8 | Reuse rendered pixels while panning (blocked by #7) | 0.2 |
| 9 | Opt-in check for new versions (blocked by #2) | 0.2 |
| 10 | Local diagnostics log and a Copy diagnostics command | 0.2 |
| 11 | Design note: platform integration for macOS and Linux | 0.3 |
| 12 | Translation system for the interface | 0.3 |
| 13 | Export pages and selections as SVG | 0.3 |
| 14 | Board file format specification (draft) | 0.3 |
| 15 | Design note: references between objects, for connectors | 0.4 |
| 16 | Frames: named regions that group content | 0.4 |
| 17 | Export annotated PDFs with the original pages intact | 0.4 |
| 18 | Store a creation time on every new object (blocked by #19) | 0.4 |
| 19 | Design note: recording and replay architecture | none |
| 20 | Give exported PDFs the board name as their document title (good first issue) | 0.2 |
| 21 | Support Windows contrast themes in the toolbar, menus and dialogs (good first issue) | 0.3 |
| 22 | Check and fix colour contrast of the interface tokens (good first issue) | 0.3 |
| 23 | Generate a keyboard shortcuts reference from the in-app list (good first issue) | 0.3 |
| 24 | Script to generate large sample boards (good first issue) | 0.2 |

### Project board

The public project is [NovaLoomBoard roadmap](https://github.com/users/ghaithheni/projects/1). It is linked to the repository and contains all 24 issues.

- **Status columns:** Up next, In progress, In review and Done.
- **Views:** a default table, Board, By milestone (grouped by milestone), and Good first issues (filtered by that label).
- ROADMAP.md and the README link to it.
