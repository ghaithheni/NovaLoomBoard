import { describe, expect, it } from "vitest";
import { checkImageFile, imageSize, looksLikePdf, MAX_IMAGE_BYTES, sniffImageMime } from "./assets";
import { serializeObjects, parseClipboard } from "./clipboard";
import { buildPdfDocument, exportRegion, pageSvg, parsePageRange, pngScale, sheetFor, sheetViewBox, MAX_PNG_PIXELS, MAX_PNG_SIDE } from "./export";
import { rotateAbout, scaleAbout } from "./matrix";
import type { ImageObject, TextObject } from "./model";
import { imageBounds, objectFrame, objectHitsPoint, recolorObject, transformObject } from "./objects";
import { decodeObject, encodeObject } from "./persist";

const ASSET = "a".repeat(64);

function image(over: Partial<ImageObject> = {}): ImageObject {
  const base = { id: "img1", type: "image" as const, asset: ASSET, cx: 100, cy: 50, width: 200, height: 100, rotation: 0, ...over };
  return { ...base, bounds: imageBounds(base) };
}

// Minimal but real file headers.
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // SOI, APP0 (length 16), SOF0 (length 17)
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}
function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  const W = w - 1;
  const H = h - 1;
  b.set([W & 255, (W >> 8) & 255, (W >> 16) & 255, H & 255, (H >> 8) & 255, (H >> 16) & 255], 24);
  return b;
}

describe("image files", () => {
  it("recognises PNG, JPEG and WebP by their bytes, not their name", () => {
    expect(sniffImageMime(png(1, 1))).toBe("image/png");
    expect(sniffImageMime(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffImageMime(webpVp8x(1, 1))).toBe("image/webp");
    expect(sniffImageMime(new TextEncoder().encode("GIF89a......"))).toBeNull();
    expect(sniffImageMime(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });

  it("reads the pixel size from the header without decoding", () => {
    expect(imageSize(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(1920, 1080), "image/jpeg")).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(webpVp8x(3000, 2000), "image/webp")).toEqual({ width: 3000, height: 2000 });
    expect(imageSize(png(1, 1).slice(0, 20), "image/png")).toBeNull();
  });

  it("refuses empty, oversized, unknown and enormous images with a reason", () => {
    expect(checkImageFile(new Uint8Array())).toEqual({ error: "the file is empty" });
    expect(checkImageFile(new Uint8Array(MAX_IMAGE_BYTES + 1))).toMatchObject({ error: expect.stringContaining("larger than") });
    expect(checkImageFile(new TextEncoder().encode("hello world, not an image"))).toMatchObject({ error: expect.stringContaining("not a PNG") });
    expect(checkImageFile(png(20000, 100))).toMatchObject({ error: expect.stringContaining("too large") });
    expect(checkImageFile(png(8000, 8000))).toMatchObject({ error: expect.stringContaining("too large") });
    expect(checkImageFile(jpeg(0, 0))).toMatchObject({ error: "the image could not be read" });
    expect(checkImageFile(png(4000, 3000))).toEqual({ mime: "image/png", width: 4000, height: 3000 });
  });
});

describe("image objects", () => {
  it("rotate about their centre and keep their aspect ratio when scaled", () => {
    const img = image();
    const r = transformObject(img, rotateAbout(Math.PI / 2, 100, 50));
    expect(r.cx).toBeCloseTo(100);
    expect(r.cy).toBeCloseTo(50);
    expect(r.rotation).toBeCloseTo(Math.PI / 2);
    expect(r.bounds.maxX - r.bounds.minX).toBeCloseTo(100);
    const s = transformObject(r, scaleAbout(1.5, 1.5, 0, 0));
    expect(s.width / s.height).toBeCloseTo(2);
    expect(s.width).toBeCloseTo(300);
    expect(objectFrame(s)).toMatchObject({ w: s.width, h: s.height });
  });

  it("are hit anywhere inside, following rotation", () => {
    const img = image({ rotation: Math.PI / 4 });
    expect(objectHitsPoint(img, 100, 50, 0)).toBe(true);
    expect(objectHitsPoint(img, 100 + 90, 50, 0)).toBe(false); // outside the rotated box along x
    expect(objectHitsPoint(img, 100 + 60, 50 + 60, 0)).toBe(true); // along the rotated long axis
  });

  it("locked page backgrounds (imported PDF pages) keep their flag through storage", () => {
    const back = decodeObject(encodeObject(image({ locked: true }), 0)) as ImageObject;
    expect(back.locked).toBe(true);
    expect((decodeObject(encodeObject(image(), 0)) as ImageObject).locked).toBeUndefined();
    // Anything but `true` is not locked.
    const odd = decodeObject({ id: "x", type: "image", data: JSON.stringify({ asset: ASSET, cx: 0, cy: 0, width: 1, height: 1, locked: "yes" }), points: new Uint8Array() });
    expect((odd as ImageObject).locked).toBeUndefined();
  });

  it("recognises PDFs by their signature", () => {
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7 ..."))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("junk%PDF-1.4"))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("<html>%PD F"))).toBe(false);
  });

  it("are not recoloured", () => {
    const img = image();
    expect(recolorObject(img, "#ff0000")).toBe(img);
  });

  it("round-trip through storage and the clipboard; invalid data is rejected", () => {
    const img = image({ rotation: 0.5 });
    const back = decodeObject(encodeObject(img, 3)) as ImageObject;
    expect(back).toMatchObject({ asset: ASSET, cx: 100, cy: 50, width: 200, height: 100 });
    expect(back.rotation).toBeCloseTo(0.5);
    expect(parseClipboard(serializeObjects([img]))![0]).toMatchObject({ type: "image", asset: ASSET });
    const bad = (data: object) => () => decodeObject({ id: "x", type: "image", data: JSON.stringify(data), points: new Uint8Array() });
    expect(bad({ asset: "nope", cx: 0, cy: 0, width: 1, height: 1 })).toThrow(/asset/);
    expect(bad({ asset: ASSET, cx: 0, cy: 0, width: 0, height: 1 })).toThrow(/size/);
    expect(bad({ asset: ASSET, cx: "x", cy: 0, width: 1, height: 1 })).toThrow(/position/);
  });
});

describe("export", () => {
  it("parses page ranges", () => {
    expect(parsePageRange("1-3, 5", 6)).toEqual({ pages: [0, 1, 2, 4] });
    expect(parsePageRange("4-", 6)).toEqual({ pages: [3, 4, 5] });
    expect(parsePageRange("2 2 1", 3)).toEqual({ pages: [0, 1] });
    expect(parsePageRange("", 3)).toHaveProperty("error");
    expect(parsePageRange("0", 3)).toHaveProperty("error");
    expect(parsePageRange("4", 3)).toMatchObject({ error: "This board has 3 pages." });
    expect(parsePageRange("3-1", 3)).toHaveProperty("error");
    expect(parsePageRange("a", 3)).toHaveProperty("error");
  });

  it("exports all content with a margin, and an area of the board for an empty page", () => {
    const r = exportRegion([image()], 10);
    expect(r).toEqual({ minX: -10, minY: -10, maxX: 210, maxY: 110 });
    expect(exportRegion([])).toEqual({ minX: 0, minY: 0, maxX: 1280, maxY: 800 });
  });

  it("renders PNGs at 2× unless that would exceed the size limits", () => {
    expect(pngScale({ minX: 0, minY: 0, maxX: 1000, maxY: 800 })).toBe(2);
    const big = { minX: 0, minY: 0, maxX: 20000, maxY: 15000 };
    const k = pngScale(big);
    expect(20000 * k).toBeLessThanOrEqual(MAX_PNG_SIDE);
    expect(20000 * 15000 * k * k).toBeLessThanOrEqual(MAX_PNG_PIXELS + 1);
  });

  it("fits each page on an A4 sheet turned to suit it, without blowing up small content", () => {
    expect(sheetFor({ minX: 0, minY: 0, maxX: 300, maxY: 100 })).toMatchObject({ orientation: "landscape", width: 297, height: 210 });
    expect(sheetFor({ minX: 0, minY: 0, maxX: 100, maxY: 300 })).toMatchObject({ orientation: "portrait", width: 210, height: 297 });
    const sheet = sheetFor({ minX: 0, minY: 0, maxX: 3000, maxY: 1000 });
    const vb = sheetViewBox({ minX: 0, minY: 0, maxX: 3000, maxY: 1000 }, sheet);
    expect(vb.w / vb.h).toBeCloseTo(297 / 210);
    expect(vb.w * vb.mmPerUnit).toBeCloseTo(297);
    expect(3000 * vb.mmPerUnit).toBeCloseTo(277); // width fits inside the 10 mm margins
    const tiny = sheetViewBox({ minX: 0, minY: 0, maxX: 20, maxY: 10 }, sheet);
    expect(tiny.mmPerUnit).toBeLessThanOrEqual(0.4);
  });

  it("keeps text as real text (Arabic, French, mixed) with its direction, escapes it, and inlines images", () => {
    const text = (t: string, align: "left" | "right" = "left"): TextObject => ({
      id: t,
      type: "text",
      x: 10,
      y: 20,
      width: 300,
      height: 36,
      text: t,
      rotation: 0.25,
      style: { color: "#1e293b", fontSize: 28, bold: true, italic: false, align },
      bounds: { minX: 0, minY: 0, maxX: 320, maxY: 60 },
    });
    const svg = pageSvg(
      { objects: [text("مرحبا بالعالم 123", "right"), text("Élève: <x> & ça"), image()], background: "grid" },
      sheetFor({ minX: 0, minY: 0, maxX: 400, maxY: 200 }),
      new Map([[ASSET, "data:image/png;base64,AAAA"]]),
      "p0",
    );
    expect(svg).toContain("مرحبا بالعالم 123");
    expect(svg).toContain("Élève: &lt;x&gt; &amp; ça");
    expect(svg).toContain('<div dir="rtl" style="height:36.4px">مرحبا بالعالم 123</div>');
    expect(svg).toContain('<div dir="ltr" style="height:36.4px">Élève: &lt;x&gt; &amp; ça</div>');
    expect(svg).toContain("text-align:right");
    expect(svg).toContain("font-weight:700");
    expect(svg).toMatch(/rotate\(14\.32\d* 10 20\)/);
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
    expect(svg).toContain('width="297mm"');
    expect(svg).not.toContain("<x>");
  });
  it("gives the PDF document the board's name as its title, escaped, and a language", async () => {
    const pages = [{ objects: [], background: "blank" as const }];
    const noAssets = async () => null;
    const { html } = await buildPdfDocument(pages, noAssets, undefined, `Maths <b> & "quotes" 'single'`);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Maths &lt;b&gt; &amp; &quot;quotes&quot; &#39;single&#39;</title>");
    expect(html).not.toContain("<b>");
    for (const empty of [undefined, "", "   "]) {
      expect((await buildPdfDocument(pages, noAssets, undefined, empty)).html).toContain("<title>Untitled board</title>");
    }
  });
});
