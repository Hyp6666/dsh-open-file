import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileOperations } from "../src/tools/operations.js";
import { UploadService } from "../src/upload/service.js";
import type { OcrEngine } from "../src/ocr/service.js";
import { WorkspaceRepository } from "../src/storage/repository.js";
import type { ToolOperationContext } from "../src/tools/context.js";
import { writeZip } from "./helpers/zip.js";

let workspace: string;
let uploads: UploadService;
let context: ToolOperationContext;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dsh-open-file-operations-"));
  uploads = new UploadService({ resolveWorkspace: () => Promise.resolve(workspace) });
  context = Object.freeze({
    workspace,
    sessionId: "session-a",
    signal: new AbortController().signal
  });
});

afterEach(async () => rm(workspace, { recursive: true, force: true }));

async function upload(name: string, bytes: Buffer, declaredType?: string): Promise<{ fileRef: string; fileId: string }> {
  const prepared = await uploads.prepare({
    sessionId: "session-a",
    name,
    size: bytes.length,
    ...(declaredType === undefined ? {} : { declaredType })
  });
  await uploads.write({
    sessionId: "session-a",
    uploadId: prepared.uploadId,
    bytes: Readable.from(bytes)
  });
  const metadata = await uploads.commit({ sessionId: "session-a", uploadId: prepared.uploadId });
  return { fileRef: metadata.fileRef, fileId: metadata.fileId };
}

describe("real file tool operations", () => {
  it("inspects and cursor-reads text with the same provenance", async () => {
    const uploaded = await upload("notes.txt", Buffer.from("one\ntwo\nthree", "utf8"));
    const operations = new FileOperations();
    const inspected = await operations.inspect(context, { file_ref: uploaded.fileRef });
    const parts = inspected.data.parts as Array<{ part_ref: string }>;
    expect(parts).toHaveLength(1);
    expect(inspected.file_ref).toBe(uploaded.fileRef);
    expect(inspected.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspected.parser).toBe("text");

    const first = await operations.read(context, {
      file_ref: uploaded.fileRef,
      part_ref: parts[0]?.part_ref ?? "",
      max_chars: 5
    });
    expect(first.data).toMatchObject({ text: "one\n", encoding: "UTF-8" });
    expect(first.cursor).toEqual(expect.any(String));
    if (first.cursor === null) throw new Error("expected a cursor");
    const second = await operations.read(context, {
      file_ref: uploaded.fileRef,
      part_ref: parts[0]?.part_ref ?? "",
      max_chars: 5,
      cursor: first.cursor
    });
    expect(second.data).toMatchObject({ text: "two\n" });
    expect(second.source_sha256).toBe(first.source_sha256);
  });

  it("inspects and reads a selected safe ZIP entry", async () => {
    const zipPath = join(workspace, "fixture.zip");
    await writeZip(zipPath, [{ name: "readme.txt", data: "archive evidence" }]);
    const { readFile } = await import("node:fs/promises");
    const uploaded = await upload("fixture.zip", await readFile(zipPath));
    const operations = new FileOperations();
    const inspected = await operations.inspect(context, { file_ref: uploaded.fileRef });
    const parts = inspected.data.parts as Array<{ part_ref: string }>;
    const read = await operations.read(context, {
      file_ref: uploaded.fileRef,
      part_ref: parts[0]?.part_ref ?? ""
    });
    expect(read.data).toMatchObject({ text: "archive evidence", entry: "readme.txt" });
    expect(read.locator).toEqual({ kind: "archive-entry", entry: "readme.txt" });
  });

  it("renders an explicit PDF page, then OCRs only the explicit render part", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([200, 100]);
    page.drawText("OCR target", { x: 20, y: 50, size: 16, font });
    const uploaded = await upload("target.pdf", Buffer.from(await pdf.save()), "application/pdf");
    const recognize = vi.fn<OcrEngine["recognize"]>().mockResolvedValue({
      text: "OCR target",
      confidence: 95
    });
    const operations = new FileOperations({ ocrEngine: { recognize } });
    const inspected = await operations.inspect(context, { file_ref: uploaded.fileRef });
    const pages = inspected.data.parts as Array<{ part_ref: string }>;
    expect(pages).toHaveLength(1);

    const rendered = await operations.render(context, {
      part_ref: pages[0]?.part_ref ?? "",
      scale: 1
    });
    expect(rendered.parser).toBe("pdfjs-render");
    expect(rendered.part_ref).toContain("/render/");

    const ocr = await operations.ocr(context, {
      part_ref: rendered.part_ref ?? "",
      languages: "eng"
    });
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(ocr).toMatchObject({
      parser: "tesseract-local",
      source_sha256: rendered.source_sha256,
      data: { text: "OCR target", confidence: 95 }
    });

    const repository = await WorkspaceRepository.open(workspace, "session-a");
    const fileDirectory = repository.fileDirectory(uploaded.fileId);
    expect(await readdir(join(fileDirectory, "renders"))).toHaveLength(1);
    expect(await readdir(join(fileDirectory, "parts"))).toHaveLength(1);
  });

  it("does not turn file_read into OCR or render routing", async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await upload("image.png", image, "image/png");
    const recognize = vi.fn<OcrEngine["recognize"]>();
    const operations = new FileOperations({ ocrEngine: { recognize } });
    const inspected = await operations.inspect(context, { file_ref: uploaded.fileRef });
    const part = (inspected.data.parts as Array<{ part_ref: string }>)[0];
    const read = await operations.read(context, {
      file_ref: uploaded.fileRef,
      part_ref: part?.part_ref ?? ""
    });
    expect(read.data).toMatchObject({
      message: "No native text projection is available for this part."
    });
    expect(JSON.stringify(read.data)).not.toMatch(/file_(?:ocr|render)/u);
    expect(recognize).not.toHaveBeenCalled();
    const repository = await WorkspaceRepository.open(workspace, "session-a");
    expect(await readdir(join(repository.fileDirectory(uploaded.fileId), "renders"))).toEqual([]);
  });
});
