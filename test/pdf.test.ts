import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "../src/contracts.js";
import { readPdf } from "../src/pdf/read.js";
import { renderPdfPage } from "../src/pdf/render.js";

let root: string;
const context = {
  sessionId: "session-a",
  fileId: "018f3f08-a9d1-7d01-9128-112233445566",
  sourceSha256: "b".repeat(64)
};

async function fixture(path: string): Promise<void> {
  const document = await PDFDocument.create();
  document.setTitle("Traceable PDF");
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, text] of ["First page", "Second page"].entries()) {
    const page = document.addPage([320, 240]);
    page.drawText(text, { x: 24, y: 180, size: 20, font });
    page.drawText(`Line ${index + 1}`, { x: 24, y: 150, size: 12, font });
  }
  await writeFile(path, await document.save());
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-open-file-pdf-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("PDF reader", () => {
  it("returns metadata and traceable page parts", async () => {
    const path = join(root, "document.pdf");
    await fixture(path);
    const result = await readPdf(path, context, {}, DEFAULT_LIMITS);
    expect(result.metadata).toMatchObject({ pageCount: 2, title: "Traceable PDF" });
    expect(result.pages.map((page) => page.text)).toEqual([
      expect.stringContaining("First page"),
      expect.stringContaining("Second page")
    ]);
    expect(result.parts).toHaveLength(2);
    expect(result.parts[1]).toMatchObject({
      locator: { kind: "page", page: 2 },
      parser: "pdfjs",
      source_sha256: context.sourceSha256
    });
  });

  it("reads only an explicit inclusive page range", async () => {
    const path = join(root, "document.pdf");
    await fixture(path);
    const result = await readPdf(path, context, { startPage: 2, endPage: 2 }, DEFAULT_LIMITS);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.page).toBe(2);
    expect(result.pages[0]?.text).toContain("Second page");
  });

  it("maps malformed input and invalid ranges to stable errors", async () => {
    const path = join(root, "bad.pdf");
    await writeFile(path, "%PDF-not-valid", "utf8");
    await expect(readPdf(path, context, {}, DEFAULT_LIMITS)).rejects.toMatchObject({
      code: "FILE_PARSE_FAILED"
    });
    await fixture(path);
    await expect(
      readPdf(path, context, { startPage: 0, endPage: 1 }, DEFAULT_LIMITS)
    ).rejects.toMatchObject({ code: "FILE_INVALID_ARGUMENT" });
  });
});

describe("PDF renderer", () => {
  it("renders only the requested page to a PNG with artifact provenance", async () => {
    const path = join(root, "document.pdf");
    const output = join(root, "page-2.png");
    await fixture(path);
    const result = await renderPdfPage({
      sourcePath: path,
      outputPath: output,
      page: 2,
      scale: 1.5,
      sourceSha256: context.sourceSha256,
      limits: DEFAULT_LIMITS
    });
    const bytes = await readFile(output);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(result).toMatchObject({
      page: 2,
      mimeType: "image/png",
      source_sha256: context.sourceSha256,
      artifact_sha256: createHash("sha256").update(bytes).digest("hex")
    });
    expect(result.width * result.height).toBeLessThanOrEqual(DEFAULT_LIMITS.maxRenderPixels);
  });

  it("rejects out-of-range pages and excess pixel counts", async () => {
    const path = join(root, "document.pdf");
    await fixture(path);
    await expect(
      renderPdfPage({
        sourcePath: path,
        outputPath: join(root, "missing.png"),
        page: 3,
        scale: 1,
        sourceSha256: context.sourceSha256,
        limits: DEFAULT_LIMITS
      })
    ).rejects.toMatchObject({ code: "FILE_PART_NOT_FOUND" });
    await expect(
      renderPdfPage({
        sourcePath: path,
        outputPath: join(root, "huge.png"),
        page: 1,
        scale: 2,
        sourceSha256: context.sourceSha256,
        limits: { ...DEFAULT_LIMITS, maxRenderPixels: 100 }
      })
    ).rejects.toMatchObject({ code: "FILE_RENDER_FAILED" });
  });
});
