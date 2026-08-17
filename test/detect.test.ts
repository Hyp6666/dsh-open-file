import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectFileType } from "../src/files/detect.js";
import { writeZip } from "./helpers/zip.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-open-file-detect-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("content-first type detection", () => {
  it("prefers magic bytes over a misleading extension", async () => {
    const path = join(root, "fake.pdf");
    await writeFile(path, "ordinary text", "utf8");
    await expect(detectFileType(path, "fake.pdf")).resolves.toMatchObject({
      detectedType: "text/plain",
      parser: "text"
    });
  });

  it.each([
    [Buffer.from("%PDF-1.7\n"), "document.bin", "application/pdf"],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image.bin", "image/png"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image.bin", "image/jpeg"]
  ])("detects %s as %s", async (bytes, name, expected) => {
    const path = join(root, name);
    await writeFile(path, bytes);
    expect((await detectFileType(path, name)).detectedType).toBe(expected);
  });

  it.each([
    ["word/document.xml", "report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["ppt/presentation.xml", "slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
    ["xl/workbook.xml", "book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"]
  ])("inspects ZIP structure for %s", async (entry, name, expectedType, parser) => {
    const path = join(root, name);
    await writeZip(path, [{ name: "[Content_Types].xml", data: "<Types/>" }, { name: entry, data: "<x/>" }]);
    await expect(detectFileType(path, name)).resolves.toMatchObject({ detectedType: expectedType, parser });
  });

  it("classifies legacy compound Office without pretending to parse it", async () => {
    const path = join(root, "old.doc");
    await writeFile(path, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    await expect(detectFileType(path, "old.doc")).resolves.toMatchObject({
      detectedType: "application/msword",
      parser: "legacy-unsupported"
    });
  });

  it("falls back to opaque binary", async () => {
    const path = join(root, "unknown");
    await writeFile(path, Buffer.from([0, 1, 2, 3, 4]));
    await expect(detectFileType(path, "unknown")).resolves.toMatchObject({
      detectedType: "application/octet-stream",
      parser: "binary"
    });
  });
});
