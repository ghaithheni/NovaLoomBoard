import { assets, buildPdfDocument, checkImageFile, renderPagePng, type BoardEngine } from "@novaloom/board-engine";
import type { ImportedImage } from "@novaloom/board-engine/persist";
import type { Persistence } from "./persistence";

const bridge = () => window.novaLoom?.files;
let busy = false;

const list = (items: string[]) =>
  items.length <= 3 ? items.join("; ") : `${items.slice(0, 3).join("; ")}; and ${items.length - 3} more`;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * File > Import images: the native dialog, then every accepted image is
 * placed on the current page in one undoable step. Refused files are listed.
 */
export async function importImages(engine: BoardEngine, persistence: Persistence): Promise<void> {
  const files = bridge();
  if (!files || busy) return;
  busy = true;
  try {
    const picked = await files.importImages();
    if (!picked) return;
    await placeImported(engine, persistence, picked);
  } catch (err) {
    persistence.showStatus({ tone: "error", text: `Images could not be imported: ${(err as Error).message}` });
  } finally {
    busy = false;
  }
}

/** Places images the main process already checked and stored; refused files are listed. */
export async function placeImported(
  engine: BoardEngine,
  persistence: Persistence,
  picked: readonly ImportedImage[],
): Promise<void> {
  const placed: { asset: string; width: number; height: number }[] = [];
  const refused: string[] = [];
  for (const f of picked) {
    if (!f.asset) {
      refused.push(`${f.name} (${f.error ?? "unknown error"})`);
      continue;
    }
    try {
      // Decoding also applies the photo's orientation, so the size is as it will be shown.
      const bitmap = await assets.put(f.asset.id, f.asset);
      placed.push({ asset: f.asset.id, width: bitmap.width, height: bitmap.height });
    } catch {
      refused.push(`${f.name} (the image could not be read)`);
    }
  }
  if (placed.length) engine.insertImages(placed);
  if (refused.length) {
    const n = picked.length;
    persistence.showStatus({
      tone: "error",
      text: `${refused.length} of ${n} image${n === 1 ? " was" : "s were"} not imported: ${list(refused)}`,
    });
  } else persistence.showStatus(null);
}

/** Who handles a PDF that arrives other than through the menu (pasted file); set by the window. */
let pdfHandler: ((name: string, data: Uint8Array) => void) | null = null;
export function setPdfHandler(fn: ((name: string, data: Uint8Array) => void) | null): void {
  pdfHandler = fn;
}
export function handlePdf(name: string, data: Uint8Array): void {
  pdfHandler?.(name, data);
}

/**
 * Inserts images given as bytes (dropped files, a pasted screenshot) in one
 * undoable step. Every file passes the same checks as File > Import images:
 * here for a quick reason, and again in the main process when it is stored.
 */
export async function insertImageBytes(
  engine: BoardEngine,
  persistence: Persistence,
  items: readonly { name: string; data: Uint8Array }[],
  at?: { clientX: number; clientY: number },
): Promise<void> {
  const files = bridge();
  if (!files || busy || !items.length) return;
  busy = true;
  const placed: { asset: string; width: number; height: number }[] = [];
  const refused: string[] = [];
  try {
    for (const item of items.slice(0, 50)) {
      const check = checkImageFile(item.data);
      if ("error" in check) {
        refused.push(`${item.name} (${check.error})`);
        continue;
      }
      try {
        const id = await files.storeAsset({ mime: check.mime, data: item.data });
        const bitmap = await assets.put(id, { mime: check.mime, data: item.data });
        placed.push({ asset: id, width: bitmap.width, height: bitmap.height });
      } catch (err) {
        refused.push(`${item.name} (${(err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")})`);
      }
    }
    if (items.length > 50) refused.push(`${items.length - 50} more (only 50 images can be added at once)`);
    if (placed.length) engine.insertImages(placed, at);
    if (refused.length) persistence.showStatus({ tone: "error", text: `Not added: ${list(refused)}` });
  } finally {
    busy = false;
  }
}

function done(persistence: Persistence, path: string, what: string): void {
  persistence.showStatus({
    tone: "success",
    text: `Exported ${what} to ${fileName(path)}.`,
    action: { label: "Show in folder", run: () => bridge()?.showInFolder(path) },
  });
}

/** File > Export page as PNG: the current page, all its content, at twice screen resolution. */
export async function exportPng(persistence: Persistence): Promise<void> {
  const files = bridge();
  if (!files || busy) return;
  const { activePage, title } = persistence.getState();
  const page = persistence.pageForExport(activePage);
  if (!page) return;
  busy = true;
  try {
    const path = await files.chooseExportPath("png", `${title} - ${page.label}`);
    if (!path) return;
    persistence.showStatus({ tone: "progress", text: "Exporting PNG…" });
    const { canvas } = await renderPagePng(page.objects, page.background);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("the page could not be drawn (it may be too large)");
    await files.writeExport(path, new Uint8Array(await blob.arrayBuffer()));
    done(persistence, path, page.label);
  } catch (err) {
    persistence.showStatus({ tone: "error", text: `The PNG could not be exported: ${(err as Error).message}` });
  } finally {
    busy = false;
  }
}

/** Exports the given pages (in board order) as one PDF, one A4 sheet per page. */
export async function exportPdf(persistence: Persistence, pageIds: readonly string[]): Promise<void> {
  const files = bridge();
  if (!files || busy || !pageIds.length) return;
  busy = true;
  try {
    const { title } = persistence.getState();
    const path = await files.chooseExportPath("pdf", title);
    if (!path) return;
    const pages = pageIds.map((id) => persistence.pageForExport(id)).filter((p) => p !== null);
    const total = pages.length;
    const { html, missingImages } = await buildPdfDocument(
      pages,
      (id) => files.readAsset(id),
      (n) => {
        if (total > 1) persistence.showStatus({ tone: "progress", text: `Exporting PDF: preparing page ${n} of ${total}…` });
      },
      title,
    );
    persistence.showStatus({ tone: "progress", text: total > 1 ? `Exporting PDF: writing ${total} pages…` : "Exporting PDF…" });
    await files.exportPdf(path, html);
    done(persistence, path, total === 1 ? "1 page" : `${total} pages`);
    if (missingImages) console.warn(`[export] ${missingImages} image(s) were missing`);
  } catch (err) {
    persistence.showStatus({ tone: "error", text: `The PDF could not be exported: ${(err as Error).message}` });
  } finally {
    busy = false;
  }
}
