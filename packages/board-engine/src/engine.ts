import { type Camera, clampZoom, fitBoundsInset, panBy, screenToWorld, worldToScreen, zoomAt } from "./camera";
import { erasePolyline, pointsBounds, unionBounds } from "./geometry";
import { alignOffsets, badgeSpots, distributeOffsets, expandToGroups, lassoSelects, orientedFrame, unitsOf, wholeGroup, type AlignEdge } from "./arrange";
import { assets } from "./assets";
import { History, pickRedo, pickUndo } from "./history";
import { needsSimulatedPressure } from "./ink";
import { predictedInk, trimSamples, type InkSample } from "./predict";
import {
  type Guide,
  type GuideKind,
  type GuideSnap,
  hitGuide,
  PROTRACTOR_RADIUS,
  protractorAngle,
  rotateKnobAngle,
  snapGuideAngle,
  snapPoint,
  toLocal,
  UNITS_PER_MM,
} from "./guides";
import { inkColor, isDarkBackground, paperColor } from "./paper";
import { recognizeShape, shapeToInk, smoothInk } from "./recognize";
import {
  createPage,
  newId,
  type BoardObject,
  type Bounds,
  type ImageObject,
  type InkTool,
  type Page,
  type ShapeKind,
  type ShapeObject,
  type ShapeStyle,
  type StrokeObject,
  type StrokeStyle,
  type TextObject,
  type TextStyle,
} from "./model";
import { cloneObjects, parseClipboard, plainTextOf, serializeObjects, unionOf } from "./clipboard";
import { isIdentity, normalizeAngle, rotateAbout, translate, type Matrix } from "./matrix";
import {
  boundsContain,
  boundsFrame,
  frameCorners,
  framePointInside,
  hasColor,
  hasOwnRotation,
  imageBounds,
  isBoxShape,
  objectFrame,
  objectHitsPoint,
  objectHitsSegment,
  recolorObject,
  shapeBounds,
  textBounds,
  transformFrame,
  transformObject,
  TEXT_LINE_HEIGHT,
  type Frame,
} from "./objects";
import { applyOps, invertBatch, type Batch, type Operation, type ResolvedOp } from "./ops";
import { type Background, HANDLE_SIZE, LASER_FADE_MS, type LaserPoint, type LiveStroke, LOCK_BADGE_SIZE, type Overlay, Renderer, ROTATE_HANDLE_OFFSET } from "./renderer";
import {
  angleFrom,
  CORNER_HANDLES,
  type Handle,
  handleCursor,
  handlePoint,
  resizeMatrix,
  rotationHandlePoint,
  SIDE_HANDLES,
  snapAngle,
} from "./selection";
import { SpatialIndex } from "./spatial";
import { TextEditor } from "./text-editor";
import { DEFAULT_TEXT_STYLE, measureText } from "./text-layout";

/** Text sizes the size buttons and Ctrl+Shift+> / < step through. */
export const TEXT_SIZE_STEPS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 96, 128, 160, 200, 256];

/** The next size up (+1) or down (-1) from `size`. */
export function stepTextSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return TEXT_SIZE_STEPS.find((s) => s > size + 1e-6) ?? Math.min(2000, Math.round(size * 1.25));
  return [...TEXT_SIZE_STEPS].reverse().find((s) => s < size - 1e-6) ?? Math.max(4, Math.round(size * 0.8));
}

export type SelectMode = "box" | "lasso";

/** What a right-click is on: an object (now selected), a locked object, or empty board. */
export interface ContextTarget {
  kind: "object" | "locked" | "canvas";
  /** The object under the pointer (the locked one for "locked"). */
  id?: string;
  /** The board point, for "paste here". */
  world: { x: number; y: number };
}

export type Tool = InkTool | "eraser" | "pan" | "select" | "shape" | "text" | "laser";
export type EraserMode = "stroke" | "partial";

/** A change to the saved document, emitted after it is applied. */
export type DocumentChange =
  | { kind: "objects"; batch: Batch }
  | { kind: "background"; background: Background };

/**
 * Undo history kept outside the engine (page operations). Ctrl+Z reverts
 * whichever is more recent: the page's own last action or this history's;
 * redo re-applies whichever was undone last. Stamps come from
 * {@link nextStamp}, shared with the page histories.
 */
export interface ExternalHistory {
  readonly undoStamp: number | undefined;
  readonly redoStamp: number | undefined;
  undo(): void;
  redo(): void;
  /** A new action was recorded on the page: whatever could be redone is no longer valid. */
  onEdit(): void;
}

export interface LoadedDocument {
  objects: readonly BoardObject[];
  background?: Background;
  view?: Camera;
  /**
   * Undo history to continue with (each page keeps its own, so undo never
   * reaches into another page). A fresh history when omitted.
   */
  history?: History;
}

/** What the interface needs to know about the current selection. */
export interface SelectionInfo {
  count: number;
  /** Selection frame in board-element pixels. */
  screen: Bounds;
  strokes: number;
  shapes: number;
  texts: number;
  images: number;
  /** Colour shared by every selected object, if any. */
  color: string | null;
  /** Rotation of the selection frame in degrees (-180, 180]. */
  angle: number;
  /** Objects that move together: each group counts once (for align/distribute). */
  units: number;
  /** True when a selected object belongs to a group. */
  grouped: boolean;
}

export interface EngineState {
  tool: Tool;
  styles: Record<InkTool, StrokeStyle>;
  eraserMode: EraserMode;
  shapeKind: ShapeKind;
  shapeStyle: ShapeStyle;
  /** Style of the text being edited or selected, else the style for new text. */
  textStyle: TextStyle;
  background: Background;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  objectCount: number;
  selection: SelectionInfo | null;
  editingText: boolean;
  /** How the select tool picks objects by dragging: a rectangle or a freehand loop. */
  selectMode: SelectMode;
  /** The ruler and the protractor are shown. */
  ruler: boolean;
  protractor: boolean;
  /** Holding still at the end of a stroke turns it into a clean line or shape. */
  shapeSnap: boolean;
}

export const DEFAULT_STYLES: Record<InkTool, StrokeStyle> = {
  pen: { color: "#1e293b", size: 4, opacity: 1 },
  pencil: { color: "#334155", size: 3, opacity: 0.9 },
  highlighter: { color: "#facc15", size: 20, opacity: 0.4 },
};

export const DEFAULT_SHAPE_STYLE: ShapeStyle = { color: "#1e293b", size: 3, opacity: 1, fill: "none" };

/** Eraser radius in screen pixels. */
const ERASER_RADIUS_PX = 10;
/** Click tolerance for selecting objects, in screen pixels. */
const HIT_TOLERANCE_PX = 6;
/** Pointer travel (screen px) before a press on an object becomes a drag. */
const DRAG_THRESHOLD_PX = 3;
/** Shapes smaller than this on screen are treated as a click and discarded. */
const MIN_SHAPE_PX = 4;
/** Holding a finger or pen still this long opens the right-click menu (the Windows convention). */
export const LONG_PRESS_MS = 550;
/** Movement (screen pixels) that turns a press into a drag instead of a long press. */
const LONG_PRESS_SLOP_PX = 8;
/** Event fired on the board element when an equation is double-clicked: `detail` holds id, tex and color. */
export const EDIT_EQUATION_EVENT = "board-edit-equation";
/** Event fired on the board element for a long press: `detail` holds clientX and clientY. */
export const LONG_PRESS_EVENT = "board-long-press";

/** Offset of duplicates and pasted copies, in screen pixels. */
const COPY_OFFSET_PX = 24;
/** Holding the pointer still this long at the end of a stroke cleans it into a shape. */
export const SHAPE_HOLD_MS = 450;
/** Movement (screen pixels) that still counts as holding still. */
const HOLD_SLOP_PX = 3;
/** Jitter removed from every stroke: smoothing radius in screen pixels. */
const INK_SMOOTHING_PX = 1.2;

type Gesture =
  | {
      kind: "draw";
      pointerId: number;
      pointerType: string;
      live: LiveStroke;
      /** Drawing along the ruler or protractor. */
      snap?: GuideSnap;
      /** Where the stroke started (screen pixels), for the length or angle shown along a guide. */
      start?: { x: number; y: number };
      /** The stroke was turned into a clean shape (holding still); later movement is ignored. */
      shaped?: boolean;
      /** Last place the pointer moved to, for detecting a hold. */
      still?: { x: number; y: number };
      /** Recent input with timestamps, for predicting where the pen is going (freehand ink only). */
      samples?: InkSample[];
    }
  | { kind: "laser"; pointerId: number }
  | { kind: "guide"; pointerId: number; guide: GuideKind; mode: "move" | "rotate"; lastX: number; lastY: number }
  | { kind: "erase"; pointerId: number; lastX: number; lastY: number; ops: Batch }
  | { kind: "pan"; pointerId: number; lastX: number; lastY: number }
  | { kind: "pinch"; ids: [number, number]; startDist: number; startZoom: number; anchor: { x: number; y: number } }
  | { kind: "shape"; pointerId: number; x1: number; y1: number; x2: number; y2: number; constrain: boolean }
  | { kind: "marquee"; pointerId: number; x0: number; y0: number; x1: number; y1: number; base: Set<string> }
  | { kind: "lasso"; pointerId: number; points: number[]; base: Set<string> }
  /** Dragging out a text box with the text tool (a click makes text that grows with its content). */
  | { kind: "textbox"; pointerId: number; x0: number; y0: number; x1: number; y1: number; sx: number; sy: number }
  | {
      kind: "transform";
      pointerId: number;
      /** A resize handle, "rotate", or null for moving. */
      handle: Handle | "rotate" | null;
      startX: number;
      startY: number;
      startScreen: { x: number; y: number };
      frame: Frame;
      transform: Matrix;
      moved: boolean;
      /** Resizing a text box's width (side handle): the rewrapped text, shown live. */
      textWidth?: TextObject | null;
    };

interface TrackedPointer {
  x: number;
  y: number;
  type: string;
}

interface Editing {
  editor: TextEditor;
  /** The object being edited; null for new text. */
  original: TextObject | null;
  x: number;
  y: number;
  /** Fixed width the text wraps to (a dragged-out box), if any. */
  boxWidth?: number;
}

/** Locked objects (and imported PDF pages) cannot be selected, moved, edited or erased. */
const isLocked = (o: BoardObject) => o.locked === true;

const isInkTool = (t: Tool): t is InkTool => t === "pen" || t === "pencil" || t === "highlighter";

/**
 * Framework-independent whiteboard controller. Owns the canvases, input
 * handling, document state, selection, undo history and rendering loop.
 */
export class BoardEngine {
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly activeCanvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly page: Page = createPage();
  private readonly index = new SpatialIndex();
  private history = new History();
  private external: ExternalHistory | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly docListeners = new Set<(change: DocumentChange) => void>();
  private readonly pointers = new Map<number, TrackedPointer>();
  private readonly resizeObserver: ResizeObserver;
  /** Stops redrawing when images finish loading. */
  private readonly offAssets: () => void;
  private readonly selection = new Set<string>();
  /**
   * Frame kept after moving, resizing or rotating the current selection, so a
   * rotated group keeps a rotated frame. Valid only for `frameKey`.
   */
  private frameOverride: { key: string; frame: Frame } | null = null;
  /** Last pasted clipboard data and how many times it was pasted (for offsets). */
  private lastPaste: { data: string; count: number } | null = null;
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private state: EngineState;
  private gesture: Gesture | null = null;
  private editing: Editing | null = null;
  private penSeen = false;
  private spacePan = false;
  private shiftDown = false;
  private hover: { x: number; y: number } | null = null;
  private width = 0;
  private height = 0;
  private rect: DOMRect | null = null;
  private frame = 0;
  private dirtyStatic = true;
  private dirtyActive = true;
  /** The last active frame drew a predicted stretch of ink. */
  private predicting = false;
  private destroyed = false;
  private insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** A touch or pen press that may become a long press (right-click). */
  private longPress: { pointerId: number; x: number; y: number; clientX: number; clientY: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Watches the display scale (e.g. the window moved to a monitor with other Windows scaling). */
  private dprQuery: MediaQueryList | null = null;
  /** Ruler and protractor while shown (screen pixels), and where each was last, for showing it again. */
  private readonly guides: Record<GuideKind, Guide | null> = { ruler: null, protractor: null };
  private readonly lastGuides: Record<GuideKind, Guide | null> = { ruler: null, protractor: null };
  /** Laser pointer trails still fading out (world coordinates). */
  private laserTrails: LaserPoint[][] = [];
  /** Turns the stroke being drawn into a shape when the pointer has been still long enough. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** A reading shown next to the pointer while drawing along a guide. */
  private readout: Overlay["readout"] = null;

  constructor(private readonly root: HTMLElement) {
    this.state = {
      tool: "pen",
      styles: structuredClone(DEFAULT_STYLES),
      eraserMode: "stroke",
      shapeKind: "rect",
      shapeStyle: { ...DEFAULT_SHAPE_STYLE },
      textStyle: { ...DEFAULT_TEXT_STYLE },
      background: "grid",
      zoom: 1,
      canUndo: false,
      canRedo: false,
      objectCount: 0,
      selection: null,
      editingText: false,
      selectMode: "box",
      ruler: false,
      protractor: false,
      shapeSnap: true,
    };
    root.classList.add("nlb-board");
    if (getComputedStyle(root).position === "static") root.style.position = "relative";
    root.style.touchAction = "none";
    root.style.userSelect = "none";
    root.dataset.tool = this.state.tool;
    this.staticCanvas = this.makeCanvas();
    this.activeCanvas = this.makeCanvas();
    root.append(this.staticCanvas, this.activeCanvas);
    this.renderer = new Renderer(this.staticCanvas, this.activeCanvas);

    root.addEventListener("pointerdown", this.onPointerDown);
    root.addEventListener("pointermove", this.onPointerMove);
    root.addEventListener("pointerup", this.onPointerUp);
    root.addEventListener("pointercancel", this.onPointerCancel);
    root.addEventListener("pointerleave", this.onPointerLeave);
    root.addEventListener("dblclick", this.onDoubleClick);
    root.addEventListener("wheel", this.onWheel, { passive: false });
    root.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("blur", this.onWindowLeave);
    document.documentElement.addEventListener("mouseleave", this.onWindowLeave);
    this.offAssets = assets.onLoad((id) => {
      for (const o of this.page.objects.values()) {
        if (o.type === "image" && o.asset === id) {
          this.redraw();
          return;
        }
      }
    });
    this.watchScale();
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(root);
    this.onResize();
  }

  // ---------- public API ----------

  getState = (): EngineState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called after every change that must be saved (objects, undo, redo, clear, background). */
  onDocumentChange = (listener: (change: DocumentChange) => void): (() => void) => {
    this.docListeners.add(listener);
    return () => this.docListeners.delete(listener);
  };

  /**
   * Replaces the board content (opening a file, switching pages). Call
   * {@link commitEdits} first to keep text being typed.
   */
  loadDocument(doc: LoadedDocument): void {
    this.cancelGesture();
    this.closeEditor(false);
    this.frameOverride = null;
    this.selection.clear();
    for (const id of this.page.order) this.renderer.forget(id);
    this.page.order.length = 0;
    this.page.objects.clear();
    this.index.clear();
    applyOps(this.page, doc.objects.map((object) => ({ kind: "add", object }) as Operation));
    for (const obj of this.page.objects.values()) this.index.insert(obj);
    this.history = doc.history ?? new History();
    // Pasting onto another page lands in place first, like after a cut.
    if (this.lastPaste) this.lastPaste = { data: this.lastPaste.data, count: -1 };
    if (doc.background) this.update({ background: doc.background });
    if (doc.view && [doc.view.x, doc.view.y, doc.view.zoom].every(Number.isFinite)) {
      this.setCamera({ x: doc.view.x, y: doc.view.y, zoom: clampZoom(doc.view.zoom) });
    }
    this.syncHistory();
    this.syncSelection();
    this.redraw();
  }

  /** Finishes text being typed and stops any gesture in progress (before switching pages). */
  commitEdits(): void {
    this.cancelGesture();
    this.closeEditor(true);
  }

  /** Current camera (top-left world point and zoom). */
  getView(): Camera {
    return { ...this.camera };
  }

  /** True while a stroke, erase, pan, pinch or transform is in progress. */
  get isInteracting(): boolean {
    return this.gesture !== null;
  }

  setTool(tool: Tool): void {
    this.cancelGesture();
    if (tool !== "text") this.closeEditor(true);
    if (tool !== "select" && this.selection.size) {
      this.selection.clear();
      this.syncSelection();
    }
    this.update({ tool });
    this.root.dataset.tool = tool;
    this.root.style.cursor = "";
    this.redraw();
  }

  /** Shows or hides the ruler or the protractor (in the middle of the view the first time). */
  setGuide(kind: GuideKind, on: boolean): void {
    if (on === (this.guides[kind] !== null)) return;
    if (this.gesture?.kind === "guide" && this.gesture.guide === kind) this.cancelGesture();
    if (on) {
      const cx = this.width / 2;
      const cy = this.height / 2 + (kind === "protractor" ? PROTRACTOR_RADIUS / 2 : 0);
      this.guides[kind] = this.keepGuideInView(this.lastGuides[kind] ?? { kind, cx, cy, angle: 0 });
    } else {
      this.lastGuides[kind] = this.guides[kind];
      this.guides[kind] = null;
    }
    this.update({ [kind]: on } as Partial<EngineState>);
    this.dirtyActive = true;
    this.schedule();
  }

  toggleGuide(kind: GuideKind): void {
    this.setGuide(kind, this.guides[kind] === null);
  }

  /** Turns cleaning strokes into shapes when holding still on or off. */
  setShapeSnap(shapeSnap: boolean): void {
    this.update({ shapeSnap });
  }

  setStyle(tool: InkTool, patch: Partial<StrokeStyle>): void {
    const styles = { ...this.state.styles, [tool]: { ...this.state.styles[tool], ...patch } };
    this.update({ styles });
  }

  setEraserMode(eraserMode: EraserMode): void {
    this.update({ eraserMode });
  }

  setShapeKind(shapeKind: ShapeKind): void {
    this.update({ shapeKind });
  }

  /** Updates the style for new shapes and applies it to selected shapes. */
  setShapeStyle(patch: Partial<ShapeStyle>): void {
    this.update({ shapeStyle: { ...this.state.shapeStyle, ...patch } });
    this.replaceSelected((o) => (o.type === "shape" ? { ...o, style: { ...o.style, ...patch } } : null));
  }

  /** Updates the text being edited, or the selected texts, and the style for new text. */
  setTextStyle(patch: Partial<TextStyle>): void {
    const textStyle = { ...this.state.textStyle, ...patch };
    this.update({ textStyle });
    if (this.editing) {
      this.editing.editor.setStyle(textStyle, this.camera);
      return;
    }
    this.frameOverride = null;
    this.replaceSelected((o) => (o.type === "text" ? this.layoutText({ ...o, style: { ...o.style, ...patch } }) : null));
  }

  /** Recolours every selected object as one undoable step (images keep their pixels). */
  setSelectionColor(color: string): void {
    this.replaceSelected((o) => (!hasColor(o) || o.style.color === color ? null : recolorObject(o, color)));
  }

  /**
   * Places images (already in the asset store) in the middle of the view as
   * one undoable step and selects them. Each appears at its natural pixel
   * size on screen, side by side, scaled down together to fit the view.
   */
  insertImages(
    images: readonly { asset: string; width: number; height: number }[],
    /** Centre the images here (client coordinates, e.g. where files were dropped) instead of the view centre. */
    at?: { clientX: number; clientY: number },
  ): string[] {
    if (!images.length || this.gesture) return [];
    this.closeEditor(true);
    const view = this.viewBounds();
    const dpr = window.devicePixelRatio || 1;
    const gap = COPY_OFFSET_PX / this.camera.zoom;
    const sizes = images.map((i) => ({ w: i.width / dpr / this.camera.zoom, h: i.height / dpr / this.camera.zoom }));
    const total = sizes.reduce((s, z) => s + z.w, 0) + gap * (sizes.length - 1);
    const tallest = Math.max(...sizes.map((z) => z.h));
    const vw = view.maxX - view.minX;
    const vh = view.maxY - view.minY;
    const k = Math.min(1, (vw * 0.8) / total, (vh * 0.7) / tallest);
    const centre = at
      ? (() => {
          const r = this.root.getBoundingClientRect();
          return screenToWorld(this.camera, at.clientX - r.left, at.clientY - r.top);
        })()
      : { x: (view.minX + view.maxX) / 2, y: (view.minY + view.maxY) / 2 };
    const cy = centre.y;
    let x = centre.x - (total * k) / 2;
    const placed: ImageObject[] = images.map((img, n) => {
      const w = sizes[n]!.w * k;
      const h = sizes[n]!.h * k;
      const base = { id: newId(), type: "image" as const, asset: img.asset, cx: x + w / 2, cy, width: w, height: h, rotation: 0 };
      x += w + gap * k;
      return { ...base, bounds: imageBounds(base) };
    });
    this.commitBatch(this.applyResolved(placed.map((object) => ({ kind: "add" as const, object }))));
    const ids = placed.map((p) => p.id);
    this.select(ids);
    return ids;
  }

  setBackground(background: Background): void {
    if (background === this.state.background) return;
    this.update({ background });
    this.emitDoc({ kind: "background", background });
    // Text being typed changes colour with the board.
    this.editing?.editor.layout(this.camera);
    this.redraw();
  }

  /** Moves the view so a board point is in sight (centred), unless it already is. */
  revealPoint(x: number, y: number): void {
    const v = this.viewBounds();
    const mx = (v.maxX - v.minX) * 0.1;
    const my = (v.maxY - v.minY) * 0.1;
    if (x > v.minX + mx && x < v.maxX - mx && y > v.minY + my && y < v.maxY - my) return;
    const c = { x: (v.minX + v.maxX) / 2, y: (v.minY + v.maxY) / 2 };
    this.setCamera({ ...this.camera, x: this.camera.x + (x - c.x), y: this.camera.y + (y - c.y) });
  }

  /** Temporary pan while a key (e.g. Space) is held. */
  setSpacePan(active: boolean): void {
    this.spacePan = active;
    this.root.dataset.spacePan = active ? "true" : "false";
  }

  /** Shift state from the keyboard handler (constrains shapes and resizing). */
  setShift(down: boolean): void {
    if (this.shiftDown === down) return;
    this.shiftDown = down;
    if (this.gesture?.kind === "shape") {
      this.gesture.constrain = down;
      this.dirtyActive = true;
      this.schedule();
    }
  }

  /** Connects (or disconnects) the history of actions outside the page, see {@link ExternalHistory}. */
  setExternalHistory(external: ExternalHistory | null): void {
    this.external = external;
    this.syncHistory();
  }

  /** Re-reads undo/redo availability (after the external history changed). */
  refreshHistory(): void {
    this.syncHistory();
  }

  undo(): void {
    if (this.gesture) return;
    this.closeEditor(true);
    this.frameOverride = null;
    if (pickUndo(this.history.undoStamp, this.external?.undoStamp) === "b") {
      this.external!.undo();
      this.syncHistory();
      return;
    }
    const batch = this.history.undo();
    if (batch) this.emitBatch(this.applyResolved(invertBatch(batch)));
    this.syncHistory();
    this.syncSelection();
  }

  redo(): void {
    if (this.gesture) return;
    this.closeEditor(true);
    this.frameOverride = null;
    // Redo in the order things were done: the earlier of the two candidates first.
    if (pickRedo(this.history.redoStamp, this.external?.redoStamp) === "b") {
      this.external!.redo();
      this.syncHistory();
      return;
    }
    const batch = this.history.redo();
    if (batch) this.emitBatch(this.applyResolved(batch));
    this.syncHistory();
    this.syncSelection();
  }

  /** Removes every object from the page as one undoable step. */
  clearPage(): void {
    this.closeEditor(true);
    if (this.page.order.length === 0) return;
    const ops: Operation[] = this.objectsInOrder().map((object) => ({ kind: "remove", object }));
    this.commitBatch(this.applyResolved(ops));
    this.syncSelection();
  }

  // ----- selection -----

  /** Selects every object on the page (switches to the select tool). */
  selectAll(): void {
    this.select(this.page.order);
  }

  /** True if the page has locked objects (including imported PDF pages). */
  hasLockedContent(): boolean {
    return this.objectsInOrder().some(isLocked);
  }

  /** Box or lasso for the select tool (switches to it). */
  setSelectMode(selectMode: SelectMode): void {
    this.setTool("select");
    if (selectMode !== this.state.selectMode) this.update({ selectMode });
  }

  /** Groups the selection (two or more objects or groups) into one group, as one undoable step. */
  groupSelection(): void {
    if (this.gesture || unitsOf(this.selectedInOrder()).length < 2) return;
    const group = newId();
    this.replaceSelected((o) => {
      if (o.group === group) return null;
      const next = { ...o, group };
      delete next.groupAngle;
      return next;
    });
    this.frameOverride = null;
  }

  /** Ungroups every selected group (the objects stay selected). */
  ungroupSelection(): void {
    this.replaceSelected((o) => {
      if (!o.group) return null;
      const next = { ...o };
      delete next.group;
      delete next.groupAngle;
      return next;
    });
  }

  /** Locks the selection: it can no longer be selected, moved, edited or erased until unlocked. */
  lockSelection(): void {
    if (this.gesture || !this.selection.size) return;
    this.replaceSelected((o) => (o.locked ? null : { ...o, locked: true }));
    this.selection.clear();
    this.syncSelection();
  }

  /** Unlocks objects (and the rest of their groups), and selects them. */
  unlock(ids: readonly string[]): void {
    if (this.gesture) return;
    const all = expandToGroups(ids, this.objectsInOrder());
    const ops: ResolvedOp[] = [];
    for (const o of this.objectsInOrder()) {
      if (!all.has(o.id) || !o.locked) continue;
      const next = { ...o };
      delete next.locked;
      ops.push(...this.replaceObject(o, next));
    }
    this.commitBatch(ops);
    this.select([...all]);
  }

  /** Unlocks every locked object on the page (including imported PDF pages). */
  unlockAll(): void {
    this.unlock(this.objectsInOrder().filter(isLocked).map((o) => o.id));
  }

  /** Aligns the selected objects (groups as one) to an edge or centre line of the selection, as one step. */
  alignSelection(edge: AlignEdge): void {
    this.moveUnits((units) => alignOffsets(units, edge));
  }

  /** Spaces three or more selected objects (groups as one) evenly, as one step. */
  distributeSelection(axis: "horizontal" | "vertical"): void {
    this.moveUnits((units) => distributeOffsets(units, axis));
  }

  /**
   * Prepares a right-click at a client point: an unselected object under it
   * becomes the selection (with its group); empty board clears the selection.
   */
  contextTarget(clientX: number, clientY: number): ContextTarget {
    this.cancelGesture();
    this.closeEditor(true);
    const r = this.root.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const world = screenToWorld(this.camera, sx, sy);
    const hit = this.hitTest(sx, sy);
    if (hit) {
      if (!this.selection.has(hit.id)) this.select([...expandToGroups([hit.id], this.objectsInOrder())]);
      else if (this.state.tool !== "select") this.setTool("select");
      return { kind: "object", id: hit.id, world };
    }
    if (this.selection.size && this.insideSelection(sx, sy)) return { kind: "object", world };
    const locked = this.hitTest(sx, sy, undefined, true);
    this.clearSelection();
    if (locked) return { kind: "locked", id: locked.id, world };
    return { kind: "canvas", world };
  }

  /** Next text size up or down (the text being edited, the selected text, or new text). */
  stepTextSize(dir: 1 | -1): void {
    this.setTextStyle({ fontSize: stepTextSize(this.state.textStyle.fontSize, dir) });
  }

  clearSelection(): void {
    if (!this.selection.size) return;
    this.selection.clear();
    this.syncSelection();
  }

  /** Deletes the selected objects as one undoable step. */
  deleteSelection(): void {
    if (this.gesture || !this.selection.size) return;
    const ops: Operation[] = this.selectedInOrder().map((object) => ({ kind: "remove", object }));
    this.selection.clear();
    this.commitBatch(this.applyResolved(ops));
    this.syncSelection();
  }

  /** Moves the selection by a number of screen pixels (arrow keys). */
  nudgeSelection(dxScreen: number, dyScreen: number): void {
    if (this.gesture || !this.selection.size) return;
    const m = translate(dxScreen / this.camera.zoom, dyScreen / this.camera.zoom);
    const frame = this.selectionFrame();
    this.transformSelection(m, frame ? transformFrame(frame, m) : null);
  }

  /** Ids of the selected objects (bottom first). */
  getSelection(): string[] {
    return this.page.order.filter((id) => this.selection.has(id));
  }

  /** Selects the given objects (switches to the select tool; ignores unknown ids). */
  select(ids: readonly string[]): void {
    if (this.state.tool !== "select") this.setTool("select");
    this.selection.clear();
    for (const id of ids) {
      const o = this.page.objects.get(id);
      if (o && !isLocked(o)) this.selection.add(id);
    }
    this.syncSelection();
  }

  // ----- copy, paste, duplicate -----

  /**
   * Clipboard data for the selection, or null when nothing is selected.
   * With `cut`, the selection is also deleted (and the first paste lands in place).
   */
  copySelection(cut = false): { data: string; text: string } | null {
    const objs = this.selectedInOrder();
    if (!objs.length) return null;
    const data = serializeObjects(objs);
    this.lastPaste = { data, count: cut ? -1 : 0 };
    if (cut) this.deleteSelection();
    return { data, text: plainTextOf(objs) };
  }

  /**
   * Pastes clipboard data as new objects on top, selected. Repeated pastes
   * step further away; data from off-screen lands in the middle of the view.
   * Returns false when the data holds no NovaLoomBoard objects.
   */
  paste(data: string, at?: { clientX: number; clientY: number }): boolean {
    const objects = parseClipboard(data);
    if (!objects || !objects.length) return false;
    this.closeEditor(true);
    if (at) {
      // "Paste here": centred on the point.
      const r = this.root.getBoundingClientRect();
      const w = screenToWorld(this.camera, at.clientX - r.left, at.clientY - r.top);
      const b = unionOf(objects)!;
      this.lastPaste = { data, count: 0 };
      this.placeCopies(objects, w.x - (b.minX + b.maxX) / 2, w.y - (b.minY + b.maxY) / 2);
      return true;
    }
    const count = this.lastPaste?.data === data ? this.lastPaste.count + 1 : 1;
    this.lastPaste = { data, count };
    const step = COPY_OFFSET_PX / this.camera.zoom;
    let dx = step * count;
    let dy = step * count;
    const b = unionOf(objects)!;
    const view = this.viewBounds();
    const visible = b.maxX > view.minX && b.minX < view.maxX && b.maxY > view.minY && b.minY < view.maxY;
    if (!visible) {
      dx = (view.minX + view.maxX) / 2 - (b.minX + b.maxX) / 2 + step * (count - 1);
      dy = (view.minY + view.maxY) / 2 - (b.minY + b.maxY) / 2 + step * (count - 1);
    }
    this.placeCopies(objects, dx, dy);
    return true;
  }

  /** Pastes plain text (e.g. from another application) as a text object in the middle of the view. */
  pasteText(text: string): void {
    const clean = text.replace(/\r\n?/g, "\n").slice(0, 20_000);
    if (!clean.trim()) return;
    this.closeEditor(true);
    const view = this.viewBounds();
    const t = this.layoutText({
      id: newId(),
      type: "text",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      text: clean,
      rotation: 0,
      style: { ...this.state.textStyle },
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    });
    const placed = this.layoutText({ ...t, x: (view.minX + view.maxX) / 2 - t.width / 2, y: (view.minY + view.maxY) / 2 - t.height / 2 });
    this.commitBatch(this.applyResolved([{ kind: "add", object: placed }]));
    this.select([placed.id]);
  }

  /** Duplicates the selection, slightly offset, and selects the copies. */
  duplicateSelection(): void {
    if (this.gesture || !this.selection.size) return;
    const step = COPY_OFFSET_PX / this.camera.zoom;
    this.placeCopies(this.selectedInOrder(), step, step);
  }

  // ----- rotation -----

  /** Rotates the selection about its frame centre by `degrees` as one undoable step. */
  rotateSelection(degrees: number): void {
    const frame = this.selectionFrame();
    if (this.gesture || !frame || !Number.isFinite(degrees) || degrees === 0) return;
    const m = rotateAbout((degrees * Math.PI) / 180, frame.cx, frame.cy);
    this.transformSelection(m, transformFrame(frame, m));
  }

  /** Turns the selection so its frame has the given angle (degrees). */
  setSelectionAngle(degrees: number): void {
    const frame = this.selectionFrame();
    if (!frame || !Number.isFinite(degrees)) return;
    const current = (frame.angle * 180) / Math.PI;
    let delta = (((degrees - current) % 360) + 540) % 360 - 180;
    if (Math.abs(delta) < 1e-9) delta = 0;
    this.rotateSelection(delta);
  }

  // ----- view -----

  zoomBy(factor: number): void {
    this.setCamera(zoomAt(this.camera, this.width / 2, this.height / 2, factor));
  }

  setZoom(zoom: number): void {
    this.zoomBy(clampZoom(zoom) / this.camera.zoom);
  }

  resetView(): void {
    this.setCamera({ x: 0, y: 0, zoom: 1 });
  }

  fitContent(): void {
    const bounds = this.contentBounds();
    if (!bounds) {
      this.resetView();
      return;
    }
    // Fit into the part of the board not covered by panels (e.g. the page thumbnails).
    const cam = fitBoundsInset(bounds, this.width, this.height, this.insets);
    if (cam) this.setCamera(cam);
  }

  /**
   * Screen pixels along each edge covered by floating panels; fitting the
   * content keeps it clear of them.
   */
  setViewInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
    this.insets = { ...insets };
  }

  /** Snapshot of the committed objects (immutable values), bottom first. */
  getObjects(): BoardObject[] {
    return this.objectsInOrder();
  }

  /** The selected objects, bottom first. */
  getSelectedObjects(): BoardObject[] {
    return this.selectedInOrder();
  }

  /** The part of the board in view, in board units. */
  getViewBounds(): Bounds {
    return this.viewBounds();
  }

  /**
   * Adds lines of clean ink (flat x, y lists in board units) in the pen's colour and width,
   * with an optional text label, as one undoable step, and selects them. Used for plotted graphs.
   */
  addInkLines(lines: readonly (readonly number[])[], label?: { text: string; x: number; y: number }): string[] {
    if (!lines.length || this.gesture) return [];
    this.closeEditor(true);
    const style = { ...this.state.styles.pen };
    const added: BoardObject[] = lines
      .filter((l) => l.length >= 4)
      .map((l) => {
        const points: number[] = [];
        for (let i = 0; i < l.length; i += 2) points.push(l[i]!, l[i + 1]!, 0.5);
        return { id: newId(), type: "stroke" as const, tool: "pen" as const, style, points, simulatePressure: false, bounds: pointsBounds(points, style.size) };
      });
    if (label) {
      const t = this.layoutText({
        id: newId(),
        type: "text",
        x: label.x,
        y: label.y,
        width: 0,
        height: 0,
        text: label.text.slice(0, 300),
        rotation: 0,
        style: { ...this.state.textStyle, color: style.color, fontSize: Math.max(14, Math.min(28, this.state.textStyle.fontSize)) },
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      });
      added.push(t);
    }
    if (!added.length) return [];
    this.commitBatch(this.applyResolved(added.map((object) => ({ kind: "add" as const, object }))));
    const ids = added.map((o) => o.id);
    this.select(ids);
    return ids;
  }

  /**
   * Places an image of `width`×`height` board units in the middle of the view, or replaces
   * the image `replaceId` in place (same centre, rotation and line height). Undoable; selects it.
   */
  placeImage(img: { asset: string; width: number; height: number; equation?: { tex: string; color: string } }, replaceId?: string): string | null {
    if (this.gesture || !(img.width > 0) || !(img.height > 0)) return null;
    this.closeEditor(true);
    const old = replaceId ? this.page.objects.get(replaceId) : undefined;
    if (old && old.type === "image") {
      // Keep the size the person gave it: scale the new equation like the old one was scaled.
      const k = old.height / Math.max(1e-6, img.height);
      const base = { ...old, asset: img.asset, width: img.width * k, height: img.height * k, equation: img.equation };
      const next: ImageObject = { ...base, bounds: imageBounds(base) };
      this.commitBatch(this.replaceObject(old, next));
      this.select([next.id]);
      return next.id;
    }
    const view = this.viewBounds();
    const base = { id: newId(), type: "image" as const, asset: img.asset, cx: (view.minX + view.maxX) / 2, cy: (view.minY + view.maxY) / 2, width: img.width, height: img.height, rotation: 0, ...(img.equation ? { equation: img.equation } : {}) };
    const placed: ImageObject = { ...base, bounds: imageBounds(base) };
    this.commitBatch(this.applyResolved([{ kind: "add", object: placed }]));
    this.select([placed.id]);
    return placed.id;
  }

  destroy(): void {
    this.destroyed = true;
    this.clearHoldTimer();
    this.closeEditor(false);
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener("change", this.onScaleChange);
    this.endLongPress();
    this.offAssets();
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("blur", this.onWindowLeave);
    document.documentElement.removeEventListener("mouseleave", this.onWindowLeave);
    this.root.removeEventListener("pointerdown", this.onPointerDown);
    this.root.removeEventListener("pointermove", this.onPointerMove);
    this.root.removeEventListener("pointerup", this.onPointerUp);
    this.root.removeEventListener("pointercancel", this.onPointerCancel);
    this.root.removeEventListener("pointerleave", this.onPointerLeave);
    this.root.removeEventListener("dblclick", this.onDoubleClick);
    this.root.removeEventListener("wheel", this.onWheel);
    this.root.removeEventListener("contextmenu", this.onContextMenu);
    this.staticCanvas.remove();
    this.activeCanvas.remove();
    this.listeners.clear();
    this.docListeners.clear();
  }

  // ---------- state & rendering ----------

  private makeCanvas(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.style.position = "absolute";
    c.style.inset = "0";
    c.style.display = "block";
    return c;
  }

  private update(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch };
    if (patch.background !== undefined) {
      // Lets the interface around the board match a dark board (hints drawn over it).
      this.root.dataset.dark = isDarkBackground(patch.background) ? "true" : "false";
      this.root.style.setProperty("--board-paper", paperColor(patch.background));
    }
    for (const l of this.listeners) l();
  }

  private emitDoc(change: DocumentChange): void {
    for (const l of this.docListeners) l(change);
  }

  private emitBatch(batch: Batch): void {
    if (batch.length) this.emitDoc({ kind: "objects", batch });
  }

  /** Records a user action in history and announces it for saving. */
  private commitBatch(batch: Batch): void {
    if (!batch.length) return;
    this.history.push(batch);
    this.external?.onEdit();
    this.syncHistory();
    this.emitBatch(batch);
  }

  private syncHistory(): void {
    this.update({
      canUndo: this.history.canUndo || this.external?.undoStamp !== undefined,
      canRedo: this.history.canRedo || this.external?.redoStamp !== undefined,
      objectCount: this.page.order.length,
    });
  }

  /** Drops selected ids that no longer exist and publishes the selection to the interface. */
  private syncSelection(): void {
    for (const id of this.selection) if (!this.page.objects.has(id)) this.selection.delete(id);
    const info = this.selectionInfo();
    const patch: Partial<EngineState> = { selection: info };
    // Formatting controls show the style of what is selected.
    if (info && !this.editing) {
      const objs = this.selectedInOrder();
      const text = objs.find((o): o is TextObject => o.type === "text");
      const shape = objs.find((o): o is ShapeObject => o.type === "shape");
      if (text) patch.textStyle = { ...text.style };
      if (shape) patch.shapeStyle = { ...shape.style };
    }
    this.update(patch);
    this.redraw();
  }

  private selectionInfo(): SelectionInfo | null {
    const objs = this.selectedInOrder();
    if (!objs.length) return null;
    let b = objs[0]!.bounds;
    let strokes = 0;
    let shapes = 0;
    let texts = 0;
    let images = 0;
    let color: string | null | undefined;
    for (const o of objs) {
      b = unionBounds(b, o.bounds);
      if (o.type === "stroke") strokes++;
      else if (o.type === "shape") shapes++;
      else if (o.type === "text") texts++;
      else images++;
      if (hasColor(o)) color = color === undefined || color === o.style.color ? o.style.color : null;
    }
    // Screen box around the (possibly rotated) frame, for placing the action bar.
    const frame = this.selectionFrame() ?? boundsFrame(b);
    const pts = frameCorners(frame).map((p) => worldToScreen(this.camera, p.x, p.y));
    const screen = {
      minX: Math.min(...pts.map((p) => p.x)),
      minY: Math.min(...pts.map((p) => p.y)),
      maxX: Math.max(...pts.map((p) => p.x)),
      maxY: Math.max(...pts.map((p) => p.y)),
    };
    const angle = Math.round(((frame.angle * 180) / Math.PI) * 10) / 10;
    return {
      count: objs.length,
      screen,
      strokes,
      shapes,
      texts,
      images,
      color: color ?? null,
      angle: angle === -180 ? 180 : angle,
      units: unitsOf(objs).length,
      grouped: objs.some((o) => !!o.group),
    };
  }

  private setCamera(cam: Camera): void {
    this.camera = cam;
    this.dirtyStatic = true;
    this.dirtyActive = true;
    if (cam.zoom !== this.state.zoom) this.update({ zoom: cam.zoom });
    if (this.selection.size) this.update({ selection: this.selectionInfo() });
    this.editing?.editor.layout(cam);
    this.schedule();
  }

  private redraw(): void {
    this.dirtyStatic = true;
    this.dirtyActive = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dirtyStatic) {
        this.renderer.renderStatic(this.page, this.index, this.camera, this.state.background, this.hiddenIds());
        this.dirtyStatic = false;
      }
      if (this.dirtyActive) {
        this.renderer.renderActive(this.camera, this.overlay());
        this.dirtyActive = false;
      }
      // A prediction fades out over a few frames when input stops.
      if (this.predicting && this.gesture?.kind === "draw") {
        this.dirtyActive = true;
        this.schedule();
      }
      // Laser trails fade out frame by frame.
      if (this.laserTrails.length && this.pruneLaser()) {
        this.dirtyActive = true;
        this.schedule();
      }
    });
  }

  /** Drops faded laser points; true while some are still visible. */
  private pruneLaser(): boolean {
    const now = performance.now();
    const drawing = this.gesture?.kind === "laser";
    this.laserTrails = this.laserTrails
      .map((t, i) => (drawing && i === this.laserTrails.length - 1 ? t : t.filter((p) => now - p.t < LASER_FADE_MS)))
      .filter((t, i, all) => t.length > 0 || (drawing && i === all.length - 1));
    // Keep fading the trail being drawn from its old end.
    if (drawing) {
      const t = this.laserTrails[this.laserTrails.length - 1];
      if (t) while (t.length > 1 && now - t[0]!.t >= LASER_FADE_MS) t.shift();
    }
    return this.laserTrails.some((t) => t.length > 0);
  }

  /** Objects drawn on the overlay (or the text editor) instead of the content layer. */
  private hiddenIds(): ReadonlySet<string> {
    const hidden = new Set<string>();
    if (this.gesture?.kind === "transform" && this.gesture.moved) for (const id of this.selection) hidden.add(id);
    if (this.editing?.original) hidden.add(this.editing.original.id);
    return hidden;
  }

  private overlay(): Overlay {
    const g = this.gesture;
    const o: Overlay = { cursor: this.cursor(), dark: isDarkBackground(this.state.background), zoom: this.camera.zoom };
    const shown = [this.guides.ruler, this.guides.protractor].filter((x): x is Guide => x !== null);
    if (shown.length) o.guides = shown;
    if (this.laserTrails.length || (this.state.tool === "laser" && this.hover)) {
      o.laser = { trails: this.laserTrails, now: performance.now(), dot: this.state.tool === "laser" ? this.hover : null };
    }
    if (g?.kind === "draw" && g.snap) o.readout = this.readout;
    this.predicting = false;
    if (g?.kind === "draw") {
      // Predicted points are drawn ahead of the pen for this frame only; they never join the stroke.
      const pts = g.live.points;
      const predicted = g.samples && !g.snap && !g.shaped ? predictedInk(g.samples, pts[pts.length - 1]!, this.camera.zoom, performance.now()) : [];
      this.predicting = predicted.length > 0;
      o.live = this.predicting ? { ...g.live, predicted } : g.live;
    }
    if (g?.kind === "shape") o.liveShape = this.liveShape(g);
    if (g?.kind === "marquee") o.marquee = marqueeBox(g);
    if (g?.kind === "textbox") o.marquee = marqueeBox(g);
    if (g?.kind === "lasso") o.lasso = g.points;
    // Locked objects show a small padlock where locking matters (selecting and erasing).
    if (this.state.tool === "select" || this.state.tool === "eraser") o.locks = this.lockBadges();
    let frame = this.selectionFrame();
    if (frame) {
      let label: string | undefined;
      if (g?.kind === "transform" && g.moved) {
        if (g.textWidth) {
          o.preview = { objects: [g.textWidth], transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } };
          frame = objectFrame(g.textWidth);
        } else {
          o.preview = { objects: this.selectedInOrder(), transform: g.transform };
          frame = transformFrame(g.frame, g.transform);
        }
        if (g.handle === "rotate") label = `${Math.round((normalizeAngle(frame.angle) * 180) / Math.PI)}°`;
      }
      o.selection = { frame, corners: true, sides: this.sideHandles(frame), rotate: true, label };
    }
    return o;
  }

  private cursor(): Overlay["cursor"] {
    if (this.state.tool !== "eraser" || !this.hover) return null;
    if (this.gesture && this.gesture.kind !== "erase") return null;
    return { x: this.hover.x, y: this.hover.y, radius: ERASER_RADIUS_PX };
  }

  /** A scale change without a size change would otherwise leave the canvases blurry. */
  private watchScale(): void {
    this.dprQuery?.removeEventListener("change", this.onScaleChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener("change", this.onScaleChange);
  }

  private onScaleChange = (): void => {
    if (this.destroyed) return;
    this.watchScale();
    this.onResize();
  };

  private onResize = (): void => {
    const r = this.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.rect = r;
    this.width = r.width;
    this.height = r.height;
    this.renderer.resize(r.width, r.height, dpr);
    for (const kind of ["ruler", "protractor"] as const) {
      const g = this.guides[kind];
      if (g) this.guides[kind] = this.keepGuideInView(g);
    }
    if (this.selection.size) this.update({ selection: this.selectionInfo() });
    this.redraw();
  };

  private applyResolved(ops: readonly (Operation | ResolvedOp)[]): Batch {
    const resolved = applyOps(this.page, ops);
    for (const op of resolved) {
      // Always remove first: an object can be replaced under the same id.
      this.index.remove(op.object.id);
      this.renderer.forget(op.object.id);
      if (op.kind === "add") this.index.insert(op.object);
    }
    if (resolved.length) this.redraw();
    return resolved;
  }

  private contentBounds(): Bounds | null {
    let b: Bounds | null = null;
    for (const obj of this.page.objects.values()) b = b ? unionBounds(b, obj.bounds) : obj.bounds;
    return b;
  }

  private objectsInOrder(): BoardObject[] {
    return this.page.order.map((id) => this.page.objects.get(id)).filter((o): o is BoardObject => !!o);
  }

  private selectedInOrder(): BoardObject[] {
    return this.objectsInOrder().filter((o) => this.selection.has(o.id));
  }

  private selectionKey(): string {
    return [...this.selection].sort().join(" ");
  }

  /**
   * The selection frame: kept from the last transform of this selection, the
   * object's own rotated frame for a single box shape or text, else the
   * axis-aligned bounds.
   */
  private selectionFrame(): Frame | null {
    const objs = this.selectedInOrder();
    if (!objs.length) return null;
    if (this.frameOverride && this.frameOverride.key === this.selectionKey()) return this.frameOverride.frame;
    if (objs.length === 1) return objectFrame(objs[0]!);
    // A whole group: its frame keeps the group's rotation, also after it is deselected and reselected.
    if (wholeGroup(objs, this.objectsInOrder())) return orientedFrame(objs, objs[0]!.groupAngle ?? 0);
    return boundsFrame(unionOf(objs)!);
  }

  /**
   * True when only aspect-preserving resizing is possible: text scales its
   * font, and a rotated box shape cannot be stretched along other axes than its own.
   */
  private uniformOnly(frame: Frame): boolean {
    for (const id of this.selection) {
      const o = this.page.objects.get(id);
      if (!o) continue;
      if (o.type === "text" || o.type === "image") return true;
      if (isBoxShape(o) && Math.abs(Math.sin(2 * (o.rotation - frame.angle))) > 1e-6) return true;
    }
    return false;
  }

  /**
   * Side handles offered: a single text box can be made wider or narrower
   * (its lines rewrap); otherwise all four, unless only uniform resizing applies.
   */
  private sideHandles(frame: Frame): boolean | Handle[] {
    const objs = this.selectedInOrder();
    if (objs.length === 1 && objs[0]!.type === "text") return ["e", "w"];
    return !this.uniformOnly(frame);
  }

  /**
   * One badge per locked object or locked group: at the top-right of its
   * part that is on screen, so it stays visible when zoomed in, and only for
   * objects big enough on screen to carry it.
   */
  private lockBadges(): { x: number; y: number }[] {
    const locked = this.objectsInOrder().filter(isLocked);
    if (!locked.length) return [];
    const rects = unitsOf(locked).map((u) => {
      const a = worldToScreen(this.camera, u.bounds.minX, u.bounds.minY);
      const b = worldToScreen(this.camera, u.bounds.maxX, u.bounds.maxY);
      return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
    });
    return badgeSpots(rects, this.width, this.height, LOCK_BADGE_SIZE / 2 + 6);
  }

  /** The single selected text object, if that is the whole selection. */
  private singleText(): TextObject | null {
    const objs = this.selectedInOrder();
    return objs.length === 1 && objs[0]!.type === "text" ? objs[0] : null;
  }

  /** Moves each unit (group or object) of the selection by its offset, as one undoable step. */
  private moveUnits(offsets: (units: ReturnType<typeof unitsOf>) => { dx: number; dy: number }[]): void {
    if (this.gesture) return;
    const units = unitsOf(this.selectedInOrder());
    const by = new Map<string, { dx: number; dy: number }>();
    offsets(units).forEach((d, i) => units[i]!.ids.forEach((id) => by.set(id, d)));
    this.replaceSelected((o) => {
      const d = by.get(o.id);
      if (!d || (Math.abs(d.dx) < 1e-9 && Math.abs(d.dy) < 1e-9)) return null;
      return transformObject(o, translate(d.dx, d.dy));
    });
    this.frameOverride = null;
    this.update({ selection: this.selectionInfo() });
  }

  /** Visible world area. */
  private viewBounds(): Bounds {
    const a = screenToWorld(this.camera, 0, 0);
    const b = screenToWorld(this.camera, this.width, this.height);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }

  /** Adds copies of objects, moved by (dx, dy), on top as one undoable step, and selects them. */
  private placeCopies(objects: readonly BoardObject[], dx: number, dy: number): void {
    const copies = cloneObjects(objects, dx, dy).map((o) => (o.type === "text" ? this.layoutText(o) : o));
    this.commitBatch(this.applyResolved(copies.map((object) => ({ kind: "add" as const, object }))));
    this.select(copies.map((o) => o.id));
  }

  /**
   * Replaces selected objects in place (same id, same z position) as one
   * undoable step. `fn` returns the replacement, or null to leave an object.
   */
  private replaceSelected(fn: (o: BoardObject) => BoardObject | null): void {
    if (this.gesture || !this.selection.size) return;
    const ops: ResolvedOp[] = [];
    for (const obj of this.selectedInOrder()) {
      const next = fn(obj);
      if (next && next !== obj) ops.push(...this.replaceObject(obj, next));
    }
    this.commitBatch(ops);
    this.syncSelection();
  }

  /** Remove + add at the same index, so the id and z-order are preserved. */
  private replaceObject(obj: BoardObject, next: BoardObject): Batch {
    const index = this.page.order.indexOf(obj.id);
    return this.applyResolved([
      { kind: "remove", object: obj },
      { kind: "add", object: next, index },
    ]);
  }

  /** Applies a matrix to every selected object as one undoable step; `frame` is kept as the new selection frame. */
  private transformSelection(m: Matrix, frame: Frame | null): void {
    if (isIdentity(m)) return;
    const group = wholeGroup(this.selectedInOrder(), this.objectsInOrder());
    const groupAngle = group && frame ? normalizeAngle(frame.angle) : undefined;
    this.replaceSelected((o) => {
      const moved = transformObject(o, m);
      if (groupAngle !== undefined) {
        if (groupAngle) moved.groupAngle = groupAngle;
        else delete moved.groupAngle;
      }
      return moved.type === "text" ? this.layoutText(moved) : moved;
    });
    // Multi-object or rotated frames are remembered; a single object's own frame needs no override.
    this.frameOverride = frame ? { key: this.selectionKey(), frame } : null;
    this.update({ selection: this.selectionInfo() });
    this.redraw();
  }

  /** Re-measures a text object so its stored size matches the rendered layout. */
  private layoutText(t: TextObject): TextObject {
    const { width, height } = measureText(t.text, t.style, t.boxWidth);
    const next = { ...t, width, height };
    return { ...next, bounds: textBounds(next) };
  }

  /** Topmost object under a screen point, or null. */
  private hitTest(sx: number, sy: number, filter?: (o: BoardObject) => boolean, onlyLocked = false): BoardObject | null {
    const w = screenToWorld(this.camera, sx, sy);
    const r = HIT_TOLERANCE_PX / this.camera.zoom;
    let best: BoardObject | null = null;
    let bestIndex = -1;
    for (const id of this.index.search({ minX: w.x - r, minY: w.y - r, maxX: w.x + r, maxY: w.y + r })) {
      const obj = this.page.objects.get(id);
      if (!obj || isLocked(obj) !== onlyLocked || (filter && !filter(obj))) continue;
      const i = this.page.order.indexOf(id);
      if (i > bestIndex && objectHitsPoint(obj, w.x, w.y, r)) {
        best = obj;
        bestIndex = i;
      }
    }
    return best;
  }

  /** Selection handle (or the rotation handle) under a screen point. */
  private hitHandle(sx: number, sy: number): Handle | "rotate" | null {
    const frame = this.selectionFrame();
    if (!frame) return null;
    const c = worldToScreen(this.camera, frame.cx, frame.cy);
    const screen: Frame = { cx: c.x, cy: c.y, w: frame.w * this.camera.zoom, h: frame.h * this.camera.zoom, angle: frame.angle };
    const reach = HANDLE_SIZE / 2 + 4;
    const r = rotationHandlePoint(screen, ROTATE_HANDLE_OFFSET);
    if (Math.hypot(r.x - sx, r.y - sy) <= reach + 2) return "rotate";
    const sides = this.sideHandles(frame);
    for (const h of [...CORNER_HANDLES, ...(sides === true ? SIDE_HANDLES : sides === false ? [] : sides)]) {
      const p = handlePoint(screen, h);
      if (Math.abs(p.x - sx) <= reach && Math.abs(p.y - sy) <= reach) return h;
    }
    return null;
  }

  private insideSelection(sx: number, sy: number): boolean {
    const frame = this.selectionFrame();
    if (!frame) return false;
    const w = screenToWorld(this.camera, sx, sy);
    return framePointInside(frame, w.x, w.y);
  }

  // ---------- input ----------

  private local(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const r = this.rect ?? this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onContextMenu = (e: Event): void => e.preventDefault();

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) return;
    this.endLongPress();
    if (e.pointerType !== "mouse" && e.isPrimary) {
      const r = this.root.getBoundingClientRect();
      const lp = { pointerId: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, clientX: e.clientX, clientY: e.clientY };
      this.longPress = { ...lp, timer: setTimeout(() => this.fireLongPress(lp.pointerId), LONG_PRESS_MS) };
    }
    this.rect = this.root.getBoundingClientRect();
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, type: e.pointerType });
    this.root.setPointerCapture(e.pointerId);
    if (e.pointerType === "pen") this.penSeen = true;

    const touches = [...this.pointers.entries()].filter(([, t]) => t.type === "touch");
    if (e.pointerType === "touch" && touches.length >= 2) {
      // Second finger: abandon any single-finger action and pinch.
      if (this.gesture?.kind === "erase") this.finishErase();
      else this.gesture = null;
      const [a, b] = touches.slice(-2) as [[number, TrackedPointer], [number, TrackedPointer]];
      const mid = { x: (a[1].x + b[1].x) / 2, y: (a[1].y + b[1].y) / 2 };
      this.gesture = {
        kind: "pinch",
        ids: [a[0], b[0]],
        startDist: Math.max(1, Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y)),
        startZoom: this.camera.zoom,
        anchor: screenToWorld(this.camera, mid.x, mid.y),
      };
      this.redraw();
      return;
    }
    if (this.gesture) return;

    const wantsPan =
      e.button === 1 ||
      this.spacePan ||
      this.state.tool === "pan" ||
      (e.pointerType === "touch" && this.penSeen);
    if (wantsPan) {
      this.gesture = { kind: "pan", pointerId: e.pointerId, lastX: p.x, lastY: p.y };
      this.root.dataset.panning = "true";
      return;
    }

    // Clicking the board while editing text finishes the edit and does nothing else.
    if (this.editing) {
      e.preventDefault();
      this.closeEditor(true);
      return;
    }

    const w = screenToWorld(this.camera, p.x, p.y);
    const tool = this.state.tool;
    const penEraser = e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0);

    // The ruler and protractor lie on top: move or turn them, or draw along an edge.
    const guideHit = this.hitGuides(p.x, p.y, isInkTool(tool) && !penEraser);
    if (guideHit) {
      const kind = guideHit.guide.kind;
      if (guideHit.part === "close") {
        this.setGuide(kind, false);
        return;
      }
      if (guideHit.part === "rotate" || guideHit.part === "body") {
        this.gesture = { kind: "guide", pointerId: e.pointerId, guide: kind, mode: guideHit.part === "rotate" ? "rotate" : "move", lastX: p.x, lastY: p.y };
        this.root.style.cursor = "grabbing";
        return;
      }
      if (guideHit.part === "edge" && isInkTool(tool)) {
        const halfPx = (this.state.styles[tool].size * this.camera.zoom) / 2;
        const sp = snapPoint(guideHit.snap, p.x, p.y, halfPx);
        const sw = screenToWorld(this.camera, sp.x, sp.y);
        const pen = e.pointerType === "pen";
        this.gesture = {
          kind: "draw",
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          live: { tool, style: { ...this.state.styles[tool] }, points: [sw.x, sw.y, pen ? e.pressure : 0.5], simulatePressure: false },
          snap: guideHit.snap,
          start: sp,
        };
        this.readout = null;
        this.redraw();
        return;
      }
    }

    if (tool === "laser") {
      this.endLongPress();
      this.laserTrails.push([{ x: w.x, y: w.y, t: performance.now() }]);
      this.gesture = { kind: "laser", pointerId: e.pointerId };
      this.hover = p;
      this.dirtyActive = true;
      this.schedule();
      return;
    }
    if (tool === "eraser" || penEraser) {
      this.gesture = { kind: "erase", pointerId: e.pointerId, lastX: w.x, lastY: w.y, ops: [] };
      this.hover = p;
      this.eraseSegment(w.x, w.y, w.x, w.y);
      return;
    }

    if (tool === "select") {
      this.startSelectGesture(e, p, w);
      return;
    }

    if (tool === "shape") {
      this.gesture = { kind: "shape", pointerId: e.pointerId, x1: w.x, y1: w.y, x2: w.x, y2: w.y, constrain: e.shiftKey };
      this.redraw();
      return;
    }

    if (tool === "text") {
      // Prevent the default focus change, which would immediately blur the new editor.
      e.preventDefault();
      const target = this.hitTest(p.x, p.y, (o) => o.type === "text") as TextObject | null;
      if (target) this.openEditor(target, 0, 0, { clientX: e.clientX, clientY: e.clientY });
      // A click makes text that grows with its content; a drag makes a box it wraps in.
      else this.gesture = { kind: "textbox", pointerId: e.pointerId, x0: w.x, y0: w.y, x1: w.x, y1: w.y, sx: p.x, sy: p.y };
      return;
    }

    if (isInkTool(tool)) {
      const pressure = e.pointerType === "pen" ? e.pressure : 0.5;
      this.gesture = {
        kind: "draw",
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        live: {
          tool,
          style: { ...this.state.styles[tool] },
          points: [w.x, w.y, pressure],
          simulatePressure: e.pointerType !== "pen",
        },
        still: p,
        samples: [{ x: w.x, y: w.y, t: e.timeStamp }],
      };
      this.redraw();
    }
  };

  private startSelectGesture(e: PointerEvent, p: { x: number; y: number }, w: { x: number; y: number }): void {
    const startTransform = (handle: Handle | "rotate" | null) => {
      const frame = this.selectionFrame();
      if (!frame) return;
      this.gesture = {
        kind: "transform",
        pointerId: e.pointerId,
        handle,
        startX: w.x,
        startY: w.y,
        startScreen: p,
        frame,
        transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
        moved: false,
      };
      if (handle === "rotate") this.root.style.cursor = "grabbing";
    };

    const handle = this.hitHandle(p.x, p.y);
    if (handle) {
      startTransform(handle);
      return;
    }
    const hit = this.hitTest(p.x, p.y);
    if (hit) {
      // A group is picked as a whole.
      const ids = expandToGroups([hit.id], this.objectsInOrder());
      if (e.shiftKey) {
        const remove = this.selection.has(hit.id);
        for (const id of ids) {
          if (remove) this.selection.delete(id);
          else this.selection.add(id);
        }
        this.syncSelection();
        return;
      }
      if (!this.selection.has(hit.id)) {
        this.selection.clear();
        for (const id of ids) this.selection.add(id);
        this.syncSelection();
      }
      startTransform(null);
      return;
    }
    if (!e.shiftKey && this.insideSelection(p.x, p.y)) {
      startTransform(null);
      return;
    }
    const base = e.shiftKey ? new Set(this.selection) : new Set<string>();
    if (!e.shiftKey) this.clearSelection();
    // Alt picks the other way (lasso instead of box, or box instead of lasso).
    if ((this.state.selectMode === "lasso") !== e.altKey) {
      this.gesture = { kind: "lasso", pointerId: e.pointerId, points: [w.x, w.y], base };
      return;
    }
    this.gesture = { kind: "marquee", pointerId: e.pointerId, x0: w.x, y0: w.y, x1: w.x, y1: w.y, base };
  }

  private onPointerMove = (e: PointerEvent): void => {
    const lp = this.longPress;
    if (lp && lp.pointerId === e.pointerId && Math.hypot(e.clientX - lp.clientX, e.clientY - lp.clientY) > LONG_PRESS_SLOP_PX) this.endLongPress();
    const p = this.local(e);
    const tracked = this.pointers.get(e.pointerId);
    if (tracked) {
      tracked.x = p.x;
      tracked.y = p.y;
    }
    const g = this.gesture;
    if (!g) {
      if ((this.state.tool === "eraser" || this.state.tool === "laser") && e.pointerType !== "touch") {
        this.hover = p;
        this.dirtyActive = true;
        this.schedule();
      } else if (this.state.tool === "select" && e.pointerType !== "touch") {
        this.updateSelectCursor(p.x, p.y);
      }
      return;
    }

    switch (g.kind) {
      case "laser": {
        if (e.pointerId !== g.pointerId) return;
        const trail = this.laserTrails[this.laserTrails.length - 1];
        const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
        for (const s of events.length ? events : [e]) {
          const sp = this.local(s);
          const w = screenToWorld(this.camera, sp.x, sp.y);
          trail?.push({ x: w.x, y: w.y, t: performance.now() });
        }
        this.hover = p;
        this.dirtyActive = true;
        this.schedule();
        return;
      }
      case "guide": {
        if (e.pointerId !== g.pointerId) return;
        const guide = this.guides[g.guide];
        if (!guide) return;
        if (g.mode === "move") {
          guide.cx += p.x - g.lastX;
          guide.cy += p.y - g.lastY;
        } else {
          guide.angle = snapGuideAngle(Math.atan2(p.y - guide.cy, p.x - guide.cx) - rotateKnobAngle(guide.kind));
        }
        g.lastX = p.x;
        g.lastY = p.y;
        this.dirtyActive = true;
        this.schedule();
        return;
      }
      case "draw": {
        if (e.pointerId !== g.pointerId) return;
        if (g.shaped) return;
        const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
        const samples = events.length ? events : [e];
        const minDist = 0.4 / this.camera.zoom;
        const pts = g.live.points;
        const halfPx = (g.live.style.size * this.camera.zoom) / 2;
        for (const s of samples) {
          let sp = this.local(s);
          if (g.snap) sp = snapPoint(g.snap, sp.x, sp.y, halfPx);
          const w = screenToWorld(this.camera, sp.x, sp.y);
          const lx = pts[pts.length - 3]!;
          const ly = pts[pts.length - 2]!;
          if (g.samples) g.samples.push({ x: w.x, y: w.y, t: s.timeStamp });
          if (Math.hypot(w.x - lx, w.y - ly) < minDist) continue;
          pts.push(w.x, w.y, g.pointerType === "pen" ? s.pressure : 0.5);
        }
        if (g.samples) trimSamples(g.samples);
        if (g.snap) {
          this.readout = this.guideReadout(g, p);
        } else {
          g.live.simulatePressure = needsSimulatedPressure(g.pointerType, pts);
          // Holding still: start (or restart) the countdown to a clean shape.
          if (this.state.shapeSnap && (!g.still || Math.hypot(p.x - g.still.x, p.y - g.still.y) > HOLD_SLOP_PX)) {
            g.still = p;
            this.clearHoldTimer();
            this.holdTimer = setTimeout(() => this.snapToShape(g), SHAPE_HOLD_MS);
          }
        }
        this.dirtyActive = true;
        this.schedule();
        return;
      }
      case "erase": {
        if (e.pointerId !== g.pointerId) return;
        const w = screenToWorld(this.camera, p.x, p.y);
        this.eraseSegment(g.lastX, g.lastY, w.x, w.y);
        g.lastX = w.x;
        g.lastY = w.y;
        this.hover = p;
        this.dirtyActive = true;
        this.schedule();
        return;
      }
      case "pan": {
        if (e.pointerId !== g.pointerId) return;
        const dx = p.x - g.lastX;
        const dy = p.y - g.lastY;
        g.lastX = p.x;
        g.lastY = p.y;
        this.setCamera(panBy(this.camera, dx, dy));
        return;
      }
      case "pinch": {
        const a = this.pointers.get(g.ids[0]);
        const b = this.pointers.get(g.ids[1]);
        if (!a || !b) return;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoom = clampZoom((g.startZoom * Math.hypot(a.x - b.x, a.y - b.y)) / g.startDist);
        this.setCamera({ x: g.anchor.x - mid.x / zoom, y: g.anchor.y - mid.y / zoom, zoom });
        return;
      }
      case "shape": {
        if (e.pointerId !== g.pointerId) return;
        const w = screenToWorld(this.camera, p.x, p.y);
        g.x2 = w.x;
        g.y2 = w.y;
        g.constrain = e.shiftKey || this.shiftDown;
        this.dirtyActive = true;
        this.schedule();
        return;
      }
      case "marquee": {
        if (e.pointerId !== g.pointerId) return;
        const w = screenToWorld(this.camera, p.x, p.y);
        g.x1 = w.x;
        g.y1 = w.y;
        const box = marqueeBox(g);
        const inside: string[] = [];
        for (const id of this.index.search(box)) {
          const obj = this.page.objects.get(id);
          if (obj && !isLocked(obj) && boundsContain(box, obj.bounds)) inside.push(id);
        }
        this.selection.clear();
        for (const id of g.base) this.selection.add(id);
        for (const id of expandToGroups(inside, this.objectsInOrder())) this.selection.add(id);
        this.syncSelection();
        return;
      }
      case "lasso": {
        if (e.pointerId !== g.pointerId) return;
        const w = screenToWorld(this.camera, p.x, p.y);
        const n = g.points.length;
        // A point every ~3 screen pixels is plenty.
        if (Math.hypot(w.x - g.points[n - 2]!, w.y - g.points[n - 1]!) * this.camera.zoom >= 3) {
          g.points.push(w.x, w.y);
          this.dirtyActive = true;
          this.schedule();
        }
        return;
      }
      case "textbox": {
        if (e.pointerId !== g.pointerId) return;
        const w = screenToWorld(this.camera, p.x, p.y);
        g.x1 = w.x;
        g.y1 = w.y;
        this.dirtyActive = true;
        this.schedule();
        return;
      }
      case "transform": {
        if (e.pointerId !== g.pointerId) return;
        if (!g.moved && Math.hypot(p.x - g.startScreen.x, p.y - g.startScreen.y) < DRAG_THRESHOLD_PX) return;
        g.moved = true;
        const w = screenToWorld(this.camera, p.x, p.y);
        const shift = e.shiftKey || this.shiftDown;
        if (g.handle === "rotate") {
          let delta = angleFrom(g.frame, w.x, w.y) - angleFrom(g.frame, g.startX, g.startY);
          // Shift snaps the resulting angle to 15° steps.
          if (shift) delta = snapAngle(g.frame.angle + delta) - g.frame.angle;
          g.transform = rotateAbout(delta, g.frame.cx, g.frame.cy);
        } else if ((g.handle === "e" || g.handle === "w") && this.singleText()) {
          // Text box width: the lines rewrap, the font size stays.
          const t = this.singleText()!;
          const ux = Math.cos(t.rotation);
          const uy = Math.sin(t.rotation);
          const along = (w.x - g.startX) * ux + (w.y - g.startY) * uy;
          const start = t.boxWidth ?? t.width;
          const width = Math.max(t.style.fontSize, g.handle === "e" ? start + along : start - along);
          // Dragging the left edge moves the text's anchor (its top-left corner) along its own axis.
          const shiftBy = g.handle === "w" ? start - width : 0;
          g.textWidth = this.layoutText({ ...t, x: t.x + ux * shiftBy, y: t.y + uy * shiftBy, boxWidth: width });
        } else if (g.handle) {
          g.transform = resizeMatrix(g.frame, g.handle, w.x - g.startX, w.y - g.startY, shift && !this.uniformOnly(g.frame));
        } else {
          g.transform = translate(w.x - g.startX, w.y - g.startY);
        }
        this.redraw();
        return;
      }
    }
  };

  private updateSelectCursor(sx: number, sy: number): void {
    const handle = this.hitHandle(sx, sy);
    const angle = this.selectionFrame()?.angle ?? 0;
    const cursor =
      handle === "rotate"
        ? "grab"
        : handle
          ? handleCursor(handle, angle)
          : this.hitTest(sx, sy) || this.insideSelection(sx, sy)
            ? "move"
            : this.hitTest(sx, sy, undefined, true)
              ? "not-allowed"
              : "";
    if (this.root.style.cursor !== cursor) this.root.style.cursor = cursor;
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (this.longPress?.pointerId === e.pointerId) this.endLongPress();
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      if (g.ids.includes(e.pointerId)) this.gesture = null;
      return;
    }
    if (g.pointerId !== e.pointerId) return;
    switch (g.kind) {
      case "draw":
        this.commitStroke(g);
        return;
      case "laser":
        this.gesture = null;
        // A finger leaves no dot behind; a mouse or pen keeps pointing.
        if (e.pointerType === "touch") this.hover = null;
        this.dirtyActive = true;
        this.schedule();
        return;
      case "guide":
        this.gesture = null;
        this.root.style.cursor = "";
        if (this.guides[g.guide]) this.guides[g.guide] = this.keepGuideInView(this.guides[g.guide]!);
        this.dirtyActive = true;
        this.schedule();
        return;
      case "erase":
        this.finishErase();
        return;
      case "shape":
        this.commitShape(g);
        return;
      case "marquee":
        this.gesture = null;
        this.syncSelection();
        return;
      case "lasso":
        this.gesture = null;
        this.finishLasso(g);
        return;
      case "textbox":
        this.gesture = null;
        this.finishTextBox(g);
        return;
      case "transform":
        this.gesture = null;
        if (g.moved && g.textWidth) {
          const t = this.singleText();
          if (t) this.commitBatch(this.replaceObject(t, g.textWidth));
          this.frameOverride = null;
          this.syncSelection();
        } else if (g.moved) this.transformSelection(g.transform, transformFrame(g.frame, g.transform));
        if (g.handle === "rotate") this.root.style.cursor = "grab";
        this.redraw();
        return;
      case "pan":
        this.gesture = null;
        delete this.root.dataset.panning;
        return;
    }
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (this.longPress?.pointerId === e.pointerId) this.endLongPress();
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch" ? g.ids.includes(e.pointerId) : g.pointerId === e.pointerId) {
      if (g.kind === "erase") this.finishErase();
      else this.cancelGesture();
    }
  };

  private onPointerLeave = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" && !this.gesture) this.clearHover();
  };

  /** The pointer left the window or entered the title bar (which sends no pointer events). */
  private onWindowLeave = (): void => {
    if (!this.gesture) this.clearHover();
  };

  private clearHover(): void {
    if (!this.hover) return;
    this.hover = null;
    this.dirtyActive = true;
    this.schedule();
  }

  private onDoubleClick = (e: MouseEvent): void => {
    if (this.state.tool !== "select" || this.editing) return;
    const p = this.local(e);
    const eq = this.hitTest(p.x, p.y, (o) => o.type === "image" && !!o.equation) as ImageObject | null;
    if (eq?.equation) {
      e.preventDefault();
      this.root.dispatchEvent(new CustomEvent(EDIT_EQUATION_EVENT, { detail: { id: eq.id, tex: eq.equation.tex, color: eq.equation.color } }));
      return;
    }
    const target = this.hitTest(p.x, p.y, (o) => o.type === "text") as TextObject | null;
    if (target) {
      e.preventDefault();
      this.setTool("text");
      this.openEditor(target, 0, 0, { clientX: e.clientX, clientY: e.clientY });
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    // Keep the eraser cursor under the pointer while scrolling (no pointermove fires).
    if (this.state.tool === "eraser" && !this.gesture) this.hover = p;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel in Chromium.
      this.setCamera(zoomAt(this.camera, p.x, p.y, Math.exp((-e.deltaY * unit) / 300)));
    } else {
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
      this.setCamera(panBy(this.camera, -dx * unit, -dy * unit));
    }
  };

  private endLongPress(): void {
    if (this.longPress) clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  /**
   * A finger or pen held still: drop whatever the press started (a dot of
   * ink, a selection box) and ask for the right-click menu at that point.
   */
  private fireLongPress(pointerId: number): void {
    const lp = this.longPress;
    this.longPress = null;
    if (!lp || lp.pointerId !== pointerId || this.destroyed || this.gesture?.kind === "pinch") return;
    const g = this.gesture;
    if (g?.kind === "transform" && g.moved) return;
    this.cancelGesture();
    this.pointers.delete(pointerId);
    this.root.dispatchEvent(new CustomEvent(LONG_PRESS_EVENT, { detail: { clientX: lp.clientX, clientY: lp.clientY } }));
  }

  private cancelGesture(): void {
    this.clearHoldTimer();
    if (this.gesture?.kind === "erase") {
      this.finishErase();
      return;
    }
    if (this.gesture?.kind === "guide") this.root.style.cursor = "";
    this.gesture = null;
    delete this.root.dataset.panning;
    this.redraw();
  }

  // ---------- tools ----------

  private commitStroke(g: Extract<Gesture, { kind: "draw" }>): void {
    this.gesture = null;
    this.clearHoldTimer();
    this.readout = null;
    const { live } = g;
    let points = live.points;
    if (points.length === 3) {
      // A tap: duplicate the point so it renders as a dot.
      points.push(points[0]! + 0.01, points[1]!, points[2]!);
    }
    // Freehand ink loses the jitter of the input device; clean shapes and lines along a guide are exact already.
    const exact = g.shaped || g.snap !== undefined;
    if (!exact) points = smoothInk(points, INK_SMOOTHING_PX / this.camera.zoom);
    // Without pen pressure, ink along a guide keeps an even width.
    const simulatePressure = exact ? false : needsSimulatedPressure(g.pointerType, points);
    const stroke: StrokeObject = {
      id: newId(),
      type: "stroke",
      tool: live.tool,
      style: live.style,
      points,
      simulatePressure,
      bounds: pointsBounds(points, live.style.size),
    };
    this.commitBatch(this.applyResolved([{ kind: "add", object: stroke }]));
    this.redraw();
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /** The pointer has been still at the end of a stroke: replace it by the clean shape it looks like. */
  private snapToShape(g: Extract<Gesture, { kind: "draw" }>): void {
    this.holdTimer = null;
    if (this.gesture !== g || g.shaped || g.snap || !this.state.shapeSnap) return;
    const z = this.camera.zoom;
    const pts = g.live.points;
    const screen: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i += 3) screen.push({ x: pts[i]! * z, y: pts[i + 1]! * z });
    const shape = recognizeShape(screen);
    if (!shape) return;
    const ink = shapeToInk(shape, 1.5);
    for (let i = 0; i < ink.length; i += 3) {
      ink[i] = ink[i]! / z;
      ink[i + 1] = ink[i + 1]! / z;
    }
    g.live.points = ink;
    g.live.simulatePressure = false;
    g.shaped = true;
    // A pen held still would also open the right-click menu.
    this.endLongPress();
    this.redraw();
  }

  /** The guide under (x, y), the protractor first (it is usually placed on the ruler's side). */
  private hitGuides(x: number, y: number, drawing: boolean): ReturnType<typeof hitGuide> {
    for (const kind of ["protractor", "ruler"] as const) {
      const g = this.guides[kind];
      const hit = g && hitGuide(g, x, y, drawing);
      if (hit) return hit;
    }
    return null;
  }

  /** Keeps a guide's centre inside the board area, so it can always be grabbed again. */
  private keepGuideInView(g: Guide): Guide {
    const m = 40;
    return { ...g, cx: Math.min(Math.max(g.cx, m), Math.max(m, this.width - m)), cy: Math.min(Math.max(g.cy, m), Math.max(m, this.height - m)) };
  }

  /** Length of a line drawn along a ruler (board centimetres) or the angle swept around the protractor. */
  private guideReadout(g: Extract<Gesture, { kind: "draw" }>, p: { x: number; y: number }): Overlay["readout"] {
    if (!g.snap || !g.start) return null;
    const pts = g.live.points;
    const end = worldToScreen(this.camera, pts[pts.length - 3]!, pts[pts.length - 2]!);
    let text: string;
    if (g.snap.kind === "arc") {
      const guide = g.snap.guide;
      const a0 = protractorAngle(guide, g.start.x, g.start.y);
      const a1 = protractorAngle(guide, end.x, end.y);
      // Outside the arc, beyond the rotate button.
      const d = Math.max(1, Math.hypot(end.x - guide.cx, end.y - guide.cy));
      const out = 46;
      return { x: end.x + ((end.x - guide.cx) / d) * out, y: end.y + ((end.y - guide.cy) / d) * out, text: `${Math.round(Math.abs(a1 - a0))}°` };
    } else {
      const cm = Math.hypot(end.x - g.start.x, end.y - g.start.y) / this.camera.zoom / UNITS_PER_MM / 10;
      text = `${cm.toFixed(1)} cm`;
    }
    // Beside the pointer, on the side away from the guide.
    const { v } = toLocal(g.snap.guide, p.x, p.y);
    const away = v >= 0 ? 1 : -1;
    const n = { x: -Math.sin(g.snap.guide.angle) * away, y: Math.cos(g.snap.guide.angle) * away };
    return { x: end.x + n.x * 34, y: end.y + n.y * 34, text };
  }

  /** The shape being drawn, with Shift constraints applied (square/circle, 15° line steps). */
  private liveShape(g: Extract<Gesture, { kind: "shape" }>): Omit<ShapeObject, "id" | "bounds"> {
    let { x2, y2 } = g;
    const kind = this.state.shapeKind;
    if (g.constrain) {
      const dx = x2 - g.x1;
      const dy = y2 - g.y1;
      if (kind === "line" || kind === "arrow") {
        const step = Math.PI / 12;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        const len = Math.hypot(dx, dy);
        x2 = g.x1 + Math.cos(angle) * len;
        y2 = g.y1 + Math.sin(angle) * len;
      } else {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        x2 = g.x1 + Math.sign(dx || 1) * side;
        y2 = g.y1 + Math.sign(dy || 1) * side;
      }
    }
    return { type: "shape", kind, x1: g.x1, y1: g.y1, x2, y2, rotation: 0, style: { ...this.state.shapeStyle } };
  }

  private commitShape(g: Extract<Gesture, { kind: "shape" }>): void {
    this.gesture = null;
    const s = this.liveShape(g);
    const sizePx = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * this.camera.zoom;
    if (sizePx >= MIN_SHAPE_PX) {
      const shape: ShapeObject = { ...s, id: newId(), bounds: shapeBounds(s) };
      this.commitBatch(this.applyResolved([{ kind: "add", object: shape }]));
    }
    this.redraw();
  }

  private openEditor(target: TextObject | null, x = 0, y = 0, caretAt?: { clientX: number; clientY: number }, boxWidth?: number): void {
    this.closeEditor(true);
    const style = target ? { ...target.style } : { ...this.state.textStyle };
    const at = { x: target?.x ?? x, y: target?.y ?? y };
    const rotation = target?.rotation ?? 0;
    const box = target ? target.boxWidth : boxWidth;
    const editor = new TextEditor(this.root, { ...at, rotation, text: target?.text ?? "", style, caretAt, boxWidth: box }, this.camera, {
      // Deferred so the event that moved focus away is handled first.
      onDone: () => queueMicrotask(() => this.editing?.editor === editor && this.closeEditor(true)),
      onSizeStep: (dir) => this.stepTextSize(dir),
      inkColor: (c) => inkColor(c, isDarkBackground(this.state.background)),
    });
    this.editing = { editor, original: target, ...at, boxWidth: box };
    this.selection.clear();
    this.update({ editingText: true, textStyle: style });
    this.syncSelection();
  }

  /** Ends text editing; with `commit`, saves the text as one undoable step. */
  private closeEditor(commit: boolean): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const text = ed.editor.text;
    const style = ed.editor.textStyle;
    ed.editor.destroy();
    this.update({ editingText: false });
    if (commit) {
      const original = ed.original;
      const blank = text.trim() === "";
      if (original && blank) {
        this.commitBatch(this.applyResolved([{ kind: "remove", object: original }]));
      } else if (!blank) {
        const unchanged = original && original.text === text && sameTextStyle(original.style, style);
        if (!unchanged) {
          const obj = this.layoutText({
            id: original?.id ?? newId(),
            type: "text",
            x: ed.x,
            y: ed.y,
            width: 0,
            height: 0,
            text,
            rotation: original?.rotation ?? 0,
            style,
            ...(ed.boxWidth !== undefined ? { boxWidth: ed.boxWidth } : {}),
            ...(original?.group ? { group: original.group } : {}),
            bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          });
          this.commitBatch(original ? this.replaceObject(original, obj) : this.applyResolved([{ kind: "add", object: obj }]));
        }
      }
    }
    this.syncSelection();
  }

  /** Selects what the lasso encloses (most of each object inside), whole groups, plus what was selected with Shift. */
  private finishLasso(g: Extract<Gesture, { kind: "lasso" }>): void {
    const poly = g.points;
    const inside: string[] = [];
    if (poly.length >= 6) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < poly.length; i += 2) {
        minX = Math.min(minX, poly[i]!);
        maxX = Math.max(maxX, poly[i]!);
        minY = Math.min(minY, poly[i + 1]!);
        maxY = Math.max(maxY, poly[i + 1]!);
      }
      for (const id of this.index.search({ minX, minY, maxX, maxY })) {
        const obj = this.page.objects.get(id);
        if (obj && !isLocked(obj) && lassoSelects(obj, poly)) inside.push(id);
      }
    }
    this.selection.clear();
    for (const id of g.base) this.selection.add(id);
    for (const id of expandToGroups(inside, this.objectsInOrder())) this.selection.add(id);
    this.syncSelection();
    this.redraw();
  }

  /** Text tool released: a click opens growing text at the point; a drag opens a box of that width. */
  private finishTextBox(g: Extract<Gesture, { kind: "textbox" }>): void {
    const width = Math.abs(g.x1 - g.x0);
    this.redraw();
    if (width * this.camera.zoom < 12) {
      // Put the middle of the first line at the click point.
      const lh = this.state.textStyle.fontSize * TEXT_LINE_HEIGHT;
      this.openEditor(null, g.x0, g.y0 - lh / 2);
      return;
    }
    this.openEditor(null, Math.min(g.x0, g.x1), Math.min(g.y0, g.y1), undefined, Math.max(width, this.state.textStyle.fontSize));
  }

  private eraseSegment(ax: number, ay: number, bx: number, by: number): void {
    const g = this.gesture;
    if (g?.kind !== "erase") return;
    const radius = ERASER_RADIUS_PX / this.camera.zoom;
    const reach = radius + 64;
    const area: Bounds = {
      minX: Math.min(ax, bx) - reach,
      minY: Math.min(ay, by) - reach,
      maxX: Math.max(ax, bx) + reach,
      maxY: Math.max(ay, by) + reach,
    };
    // Each object is applied immediately so z-indices stay exact for the next one.
    for (const id of this.index.search(area)) {
      const obj = this.page.objects.get(id);
      if (!obj || isLocked(obj)) continue;
      // Shapes and text are always erased whole; ink can also be split.
      if (this.state.eraserMode === "stroke" || obj.type !== "stroke") {
        if (objectHitsSegment(obj, ax, ay, bx, by, radius)) {
          g.ops.push(...this.applyResolved([{ kind: "remove", object: obj }]));
        }
        continue;
      }
      const runs = erasePolyline(obj.points, ax, ay, bx, by, radius + obj.style.size / 2);
      if (!runs) continue;
      const position = this.page.order.indexOf(obj.id);
      const ops: Operation[] = [{ kind: "remove", object: obj }];
      runs.forEach((pts, i) => {
        const fragment: StrokeObject = { ...obj, id: newId(), points: pts, bounds: pointsBounds(pts, obj.style.size) };
        ops.push({ kind: "add", object: fragment, index: position + i });
      });
      g.ops.push(...this.applyResolved(ops));
    }
  }

  private finishErase(): void {
    const g = this.gesture;
    if (g?.kind !== "erase") return;
    this.gesture = null;
    this.commitBatch(g.ops);
    this.syncSelection();
  }
}

/** True when any selected object carries its own rotation (used by the interface). */
export const selectionHasOwnRotation = (objects: readonly BoardObject[]) => objects.some(hasOwnRotation);

function marqueeBox(g: { x0: number; y0: number; x1: number; y1: number }): Bounds {
  return { minX: Math.min(g.x0, g.x1), minY: Math.min(g.y0, g.y1), maxX: Math.max(g.x0, g.x1), maxY: Math.max(g.y0, g.y1) };
}

function sameTextStyle(a: TextStyle, b: TextStyle): boolean {
  return a.color === b.color && a.fontSize === b.fontSize && a.bold === b.bold && a.italic === b.italic && a.align === b.align;
}
