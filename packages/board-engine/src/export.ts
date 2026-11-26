/**
 * Exporting pages: a PNG of one page (raster, drawn by the same code as the
 * screen) and a vector document for PDF (one SVG sheet per page; the desktop
 * app prints it with Chromium, so text stays real text with correct Arabic
 * shaping and mixed right-to-left / left-to-right lines, and images keep
 * their original pixels).
 */
import { assets, type AssetData } from "./assets";
import type { Camera } from "./camera";
import { dashPattern, drawObject } from "./draw";
import { unionBounds } from "./geometry";
import { outlineToSvgPath, strokeOutline } from "./ink";
import type { BoardObject, Bounds, ImageObject, ShapeObject, StrokeObject, TextObject } from "./model";
import { arrowHead, shapeOutline, TEXT_LINE_HEIGHT } from "./objects";
import { highlighterOpacity, inkColor, isDarkBackground, paperColor, parseBackground, patternGeometry, type Background } from "./paper";
import { drawBackgroundPattern } from "./renderer";
import { layoutLines, TEXT_FONT_FAMILY } from "./text-layout";
import { ThumbnailPaths } from "./thumbnail";

/** Space around the content, in board units. */
export const EXPORT_MARGIN = 48;
/** What an empty page exports: this much of the board around the origin. */
const EMPTY_REGION: Bounds = { minX: 0, minY: 0, maxX: 1280, maxY: 800 };

/** The part of the board a page export shows: all content plus a margin. */
export function exportRegion(objects: readonly BoardObject[], margin = EXPORT_MARGIN): Bounds {
  let b: Bounds | null = null;
  for (const o of objects) b = b ? unionBounds(b, o.bounds) : o.bounds;
  if (!b) return EMPTY_REGION;
  return { minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin };
}

// ---------- PNG ----------

/** Largest PNG side and area, within what canvases reliably support. */
export const MAX_PNG_SIDE = 12_000;
export const MAX_PNG_PIXELS = 80_000_000;

/** Pixels per board unit for a PNG: `preferred` (2× by default, sharp on high-density screens), reduced to fit the limits. */
export function pngScale(region: Bounds, preferred = 2): number {
  const w = region.maxX - region.minX;
  const h = region.maxY - region.minY;
  return Math.min(preferred, MAX_PNG_SIDE / w, MAX_PNG_SIDE / h, Math.sqrt(MAX_PNG_PIXELS / (w * h)));
}

/** Waits until every image on the page is decoded at the size it will be drawn (`pxPerUnit`), so exports never show placeholders. */
export async function loadImages(objects: readonly BoardObject[], pxPerUnit: number): Promise<string[]> {
  const missing: string[] = [];
  for (const o of objects) {
    if (o.type !== "image") continue;
    // One at a time: a page of large photos never needs every original decoded at once.
    if (!(await assets.whenLoaded(o.asset, Math.max(o.width, o.height) * pxPerUnit))) missing.push(o.asset);
  }
  return [...new Set(missing)];
}

/** Draws a page (background and objects) into a new canvas for PNG export. */
export async function renderPagePng(
  objects: readonly BoardObject[],
  background: Background,
  scale?: number,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number; missingImages: string[] }> {
  const region = exportRegion(objects);
  const k = scale ?? pngScale(region);
  const missingImages = await loadImages(objects, k);
  const w = region.maxX - region.minX;
  const h = region.maxY - region.minY;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("the page is too large to draw");
  ctx.fillStyle = paperColor(background);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cam: Camera = { x: region.minX, y: region.minY, zoom: 1 };
  drawBackgroundPattern(ctx, cam, background, w, h, k);
  ctx.setTransform(k, 0, 0, k, -region.minX * k, -region.minY * k);
  const paths = new ThumbnailPaths();
  const dark = isDarkBackground(background);
  for (const o of objects) drawObject(ctx, o, paths, false, dark);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, width: canvas.width, height: canvas.height, missingImages };
}

/**
 * The given objects (a selection) as a PNG canvas: on the board colour without the pattern,
 * with a small margin, as they look on the board. Used for copying as an image.
 */
export async function renderObjectsPng(objects: readonly BoardObject[], background: Background, scale = 2): Promise<HTMLCanvasElement | null> {
  if (!objects.length) return null;
  const region = exportRegion(objects, 16);
  const k = Math.min(scale, pngScale(region, scale));
  await loadImages(objects, k);
  const w = region.maxX - region.minX;
  const h = region.maxY - region.minY;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = paperColor(background);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, -region.minX * k, -region.minY * k);
  const paths = new ThumbnailPaths();
  const dark = isDarkBackground(background);
  for (const o of objects) drawObject(ctx, o, paths, false, dark);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// ---------- page ranges ----------

/**
 * Parses a page selection such as "1-3, 5, 8-" (1-based, inclusive; an open
 * end means to the last page) into sorted page indices. Returns an error
 * message for anything invalid.
 */
export function parsePageRange(input: string, pageCount: number): { pages: number[] } | { error: string } {
  const parts = input.split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return { error: "Enter the pages to export, for example 1-3, 5." };
  const set = new Set<number>();
  for (const part of parts) {
    const m = /^(\d+)?\s*(?:(-|–)\s*(\d+)?)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) return { error: `"${part}" is not a page or a range.` };
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : pageCount) : from;
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) return { error: `This board has ${pageCount} page${pageCount === 1 ? "" : "s"}.` };
    if (from > to) return { error: `"${part}" goes backwards.` };
    for (let i = from; i <= to; i++) set.add(i - 1);
  }
  return { pages: [...set].sort((a, b) => a - b) };
}

// ---------- PDF (vector) ----------

export interface Sheet {
  /** Paper size in millimetres. */
  width: number;
  height: number;
  orientation: "landscape" | "portrait";
}

const A4: [number, number] = [297, 210];
/** Paper margin around the content, in millimetres. */
const SHEET_MARGIN_MM = 10;
/** Content is never enlarged beyond this (millimetres per board unit; 0.2646 is 1:1 at 96 dpi), so a small sketch is not blown up. */
const MAX_MM_PER_UNIT = 0.4;
const MM_PER_CSS_PX = 25.4 / 96;

/** A4, turned to match the content's shape. */
export function sheetFor(region: Bounds): Sheet {
  const landscape = region.maxX - region.minX >= region.maxY - region.minY;
  return landscape ? { width: A4[0], height: A4[1], orientation: "landscape" } : { width: A4[1], height: A4[0], orientation: "portrait" };
}

/** The board area a sheet shows: the region centred and scaled to fit inside the paper margins (whole sheet, same aspect). */
export function sheetViewBox(region: Bounds, sheet: Sheet): { x: number; y: number; w: number; h: number; mmPerUnit: number } {
  const rw = region.maxX - region.minX;
  const rh = region.maxY - region.minY;
  const mmPerUnit = Math.min((sheet.width - 2 * SHEET_MARGIN_MM) / rw, (sheet.height - 2 * SHEET_MARGIN_MM) / rh, MAX_MM_PER_UNIT);
  const w = sheet.width / mmPerUnit;
  const h = sheet.height / mmPerUnit;
  const cx = (region.minX + region.maxX) / 2;
  const cy = (region.minY + region.maxY) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h, mmPerUnit };
}

const num = (n: number) => (Math.abs(n) < 1e-9 ? "0" : String(Math.round(n * 1000) / 1000));
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const deg = (rad: number) => (rad * 180) / Math.PI;

function backgroundSvg(background: Background, vb: { x: number; y: number; w: number; h: number; mmPerUnit: number }): string {
  const paper = `<rect x="${num(vb.x)}" y="${num(vb.y)}" width="${num(vb.w)}" height="${num(vb.h)}" fill="${paperColor(background)}"/>`;
  const { pattern } = parseBackground(background);
  if (pattern === "blank") return paper;
  // Laid out as on screen, for a sheet seen at its printed size.
  const pxPerUnit = vb.mmPerUnit / MM_PER_CSS_PX;
  const geo = patternGeometry(pattern, { minX: vb.x, minY: vb.y, maxX: vb.x + vb.w, maxY: vb.y + vb.h }, pxPerUnit, isDarkBackground(background));
  const px = (n: number) => n / pxPerUnit;
  let out = paper;
  for (const l of geo.lines) {
    const dash = l.dash ? ` stroke-dasharray="${l.dash.map((d) => num(px(d))).join(" ")}"` : "";
    out += `<line x1="${num(l.x1)}" y1="${num(l.y1)}" x2="${num(l.x2)}" y2="${num(l.y2)}" stroke="${l.color}" stroke-width="${num(px(l.width))}"${dash}/>`;
  }
  if (geo.dots.length) {
    out += `<g fill="${geo.dots[0]!.color}">`;
    for (const d of geo.dots) out += `<circle cx="${num(d.x)}" cy="${num(d.y)}" r="${num(px(d.r))}"/>`;
    out += "</g>";
  }
  for (const t of geo.labels) {
    const anchor = t.align === "left" ? "start" : t.align === "right" ? "end" : "middle";
    const base = t.baseline === "top" ? "hanging" : t.baseline === "middle" ? "central" : "alphabetic";
    out +=
      `<text x="${num(t.x + px(t.dx))}" y="${num(t.y + px(t.dy))}" fill="${t.color}" font-size="${num(px(11))}" font-family="Segoe UI, system-ui, sans-serif" ` +
      `text-anchor="${anchor}" dominant-baseline="${base}">${esc(t.text)}</text>`;
  }
  return out;
}

function strokeSvg(s: StrokeObject, dark: boolean): string {
  const hl = s.tool === "highlighter";
  if (s.style.dash && !hl) {
    let line = "";
    for (let i = 0; i < s.points.length; i += 3) line += `${i ? "L" : "M"}${num(s.points[i]!)} ${num(s.points[i + 1]!)}`;
    const dash = dashPattern(s.style.dash, s.style.size).map(num).join(" ");
    return `<path d="${line}" fill="none" stroke="${inkColor(s.style.color, dark)}" stroke-opacity="${num(s.style.opacity)}" stroke-width="${num(s.style.size)}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${dash}"/>`;
  }
  const d = outlineToSvgPath(strokeOutline(s.points, s.tool, s.style.size, s.simulatePressure, true));
  const blend = hl ? ` style="mix-blend-mode:${dark ? "screen" : "multiply"}"` : "";
  return `<path d="${d}" fill="${hl ? s.style.color : inkColor(s.style.color, dark)}" fill-opacity="${num(hl ? highlighterOpacity(s.style.opacity, dark) : s.style.opacity)}"${blend}/>`;
}

function shapeSvg(s: ShapeObject, dark: boolean): string {
  const { pts, closed } = shapeOutline(s);
  const st = { ...s.style, color: inkColor(s.style.color, dark) };
  const dashAttr = st.dash ? ` stroke-dasharray="${dashPattern(st.dash, st.size).map(num).join(" ")}"` : "";
  const stroke = `stroke="${st.color}" stroke-opacity="${num(st.opacity)}" stroke-width="${num(st.size)}" stroke-linejoin="round" stroke-linecap="round"`;
  if (s.kind === "arrow") {
    const hd = arrowHead(s);
    const shaft = `<path d="M${num(s.x1)} ${num(s.y1)}L${num((hd[2]! + hd[4]!) / 2)} ${num((hd[3]! + hd[5]!) / 2)}" fill="none" ${stroke}${dashAttr}/>`;
    const headStroke = stroke.replace(/stroke-width="[^"]*"/, `stroke-width="${num(Math.min(st.size, 3))}"`);
    const head = `<path d="M${num(hd[0]!)} ${num(hd[1]!)}L${num(hd[2]!)} ${num(hd[3]!)}L${num(hd[4]!)} ${num(hd[5]!)}Z" fill="${st.color}" fill-opacity="${num(st.opacity)}" ${headStroke}/>`;
    return shaft + head;
  }
  let d = `M${num(pts[0]!)} ${num(pts[1]!)}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${num(pts[i]!)} ${num(pts[i + 1]!)}`;
  if (closed) d += "Z";
  let out = "";
  if (closed && st.fill !== "none") {
    out += `<path d="${d}" fill="${st.color}" fill-opacity="${num(st.opacity * (st.fill === "tint" ? 0.16 : 1))}" stroke="none"/>`;
  }
  return out + `<path d="${d}" fill="none" ${stroke}${dashAttr}/>`;
}

/**
 * Text as an HTML block laid out like the on-board editor (same font, line
 * height, alignment and per-line direction), so the PDF keeps real,
 * selectable text with correct Arabic shaping.
 */
function textSvg(t: TextObject, dark: boolean): string {
  const lh = t.style.fontSize * TEXT_LINE_HEIGHT;
  const css = [
    `font-family:${esc(TEXT_FONT_FAMILY)}`,
    `font-size:${num(t.style.fontSize)}px`,
    `font-weight:${t.style.bold ? 700 : 400}`,
    `font-style:${t.style.italic ? "italic" : "normal"}`,
    `line-height:${num(lh)}px`,
    `color:${inkColor(t.style.color, dark)}`,
    `text-align:${t.style.align}`,
    "white-space:pre",
    `width:${num(t.width)}px`,
    "margin:0",
    "padding:0",
  ].join(";");
  // The same lines the board draws (wrapped to the text box, if it has one); each keeps its
  // paragraph's direction, so the PDF matches the board and keeps real, selectable text.
  const lines = layoutLines(t.text, t.style, t.boxWidth)
    .map((l) => `<div dir="${l.dir}" style="height:${num(lh)}px">${esc(l.text) || "&#8203;"}</div>`)
    .join("");
  const rot = t.rotation ? ` transform="rotate(${num(deg(t.rotation))} ${num(t.x)} ${num(t.y)})"` : "";
  return `<foreignObject x="${num(t.x)}" y="${num(t.y)}" width="${num(t.width + t.style.fontSize)}" height="${num(t.height + lh)}" overflow="visible"${rot}><div xmlns="http://www.w3.org/1999/xhtml" style="${css}">${lines}</div></foreignObject>`;
}

function imageSvg(i: ImageObject, href: string | undefined): string {
  const rot = i.rotation ? ` transform="rotate(${num(deg(i.rotation))} ${num(i.cx)} ${num(i.cy)})"` : "";
  const x = num(i.cx - i.width / 2);
  const y = num(i.cy - i.height / 2);
  if (!href) return `<rect x="${x}" y="${y}" width="${num(i.width)}" height="${num(i.height)}" fill="#eef0f3"${rot}/>`;
  return `<image href="${href}" x="${x}" y="${y}" width="${num(i.width)}" height="${num(i.height)}" preserveAspectRatio="none"${rot}/>`;
}

export interface ExportPage {
  objects: readonly BoardObject[];
  background: Background;
}

/** One page as an SVG sheet (paper size in millimetres, board coordinates inside). */
export function pageSvg(page: ExportPage, sheet: Sheet, images: ReadonlyMap<string, string>, id: string): string {
  const vb = sheetViewBox(exportRegion(page.objects), sheet);
  const dark = isDarkBackground(page.background);
  const body = page.objects
    .map((o) => {
      switch (o.type) {
        case "stroke":
          return strokeSvg(o, dark);
        case "shape":
          return shapeSvg(o, dark);
        case "text":
          return textSvg(o, dark);
        case "image":
          return imageSvg(o, images.get(o.asset));
      }
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.width}mm" height="${sheet.height}mm" ` +
    `viewBox="${num(vb.x)} ${num(vb.y)} ${num(vb.w)} ${num(vb.h)}" preserveAspectRatio="xMidYMid meet">` +
    `<clipPath id="${id}c"><rect x="${num(vb.x)}" y="${num(vb.y)}" width="${num(vb.w)}" height="${num(vb.h)}"/></clipPath>` +
    `<g clip-path="url(#${id}c)">${backgroundSvg(page.background, vb)}${body}</g></svg>`
  );
}

/**
 * How an image goes into the PDF. PDF has no WebP, so the printer would
 * store WebP pixels losslessly (about 1 MB per imported PDF page). Opaque
 * WebP images (imported PDF pages, photos) are converted to JPEG, which PDF
 * stores as is; images with transparency, PNG and JPEG are passed unchanged.
 */
export async function pdfImageHref(data: AssetData): Promise<string> {
  if (data.mime === "image/webp") {
    try {
      const bitmap = await createImageBitmap(new Blob([data.data as BlobPart], { type: data.mime }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = true;
        for (let i = 3; i < px.length; i += 4) {
          if (px[i]! < 255) {
            opaque = false;
            break;
          }
        }
        if (opaque) {
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", PDF_JPEG_QUALITY));
          canvas.width = canvas.height = 0;
          if (blob) return `data:image/jpeg;base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}`;
        }
        canvas.width = canvas.height = 0;
      }
    } catch {
      /* fall back to the original bytes */
    }
  }
  return `data:${data.mime};base64,${toBase64(data.data)}`;
}

const PDF_JPEG_QUALITY = 0.92;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The printable document for a PDF: one sheet per page, each A4 turned to
 * fit its content. Images are inlined from `readAsset` (original bytes, no
 * re-encoding). `onProgress` reports pages done. `title` (the board's name)
 * becomes the document title, which the printer writes into the PDF's
 * properties and screen readers announce.
 */
export async function buildPdfDocument(
  pages: readonly ExportPage[],
  readAsset: (id: string) => Promise<AssetData | null>,
  onProgress?: (done: number, total: number) => void,
  title?: string,
): Promise<{ html: string; missingImages: number }> {
  const images = new Map<string, string>();
  let missingImages = 0;
  const sheets: string[] = [];
  for (const [n, page] of pages.entries()) {
    for (const o of page.objects) {
      if (o.type !== "image" || images.has(o.asset)) continue;
      const data = await readAsset(o.asset);
      if (data) images.set(o.asset, await pdfImageHref(data));
      else missingImages++;
    }
    const sheet = sheetFor(exportRegion(page.objects));
    sheets.push(`<section class="sheet ${sheet.orientation}">${pageSvg(page, sheet, images, `p${n}`)}</section>`);
    onProgress?.(n + 1, pages.length);
    // Let the interface update between pages.
    await new Promise((r) => setTimeout(r, 0));
  }
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${esc(title?.trim() || "Untitled board")}</title>` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
    `<style>@page landscape{size:297mm 210mm;margin:0}@page portrait{size:210mm 297mm;margin:0}` +
    `html,body{margin:0;padding:0;background:#fff}.sheet{display:block;overflow:hidden;break-after:page}` +
    `.sheet:last-child{break-after:auto}.sheet.landscape{page:landscape;width:297mm;height:210mm}` +
    `.sheet.portrait{page:portrait;width:210mm;height:297mm}svg{display:block}</style></head><body>` +
    sheets.join("") +
    `</body></html>`;
  return { html, missingImages };
}
