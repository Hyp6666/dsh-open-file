import { open } from "node:fs/promises";

import { SafeZip } from "../archive/safe-zip.js";
import { DEFAULT_LIMITS } from "../contracts.js";

export interface DetectionResult {
  readonly detectedType: string;
  readonly parser: string;
  readonly family: string;
}

const LEGACY_COMPOUND_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function startsWith(buffer: Buffer, prefix: Buffer | string): boolean {
  const expected = typeof prefix === "string" ? Buffer.from(prefix, "binary") : prefix;
  return buffer.subarray(0, expected.length).equals(expected);
}

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  const replacements = [...decoded].filter((character) => character === "�").length;
  return replacements <= Math.max(1, Math.floor(decoded.length * 0.01));
}

export async function detectFileType(path: string, displayName: string): Promise<DetectionResult> {
  const handle = await open(path, "r");
  try {
    const sample = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    const lowerName = displayName.toLowerCase();

    if (startsWith(bytes, "%PDF-")) return { detectedType: "application/pdf", parser: "pdfjs", family: "pdf-page" };
    if (startsWith(bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { detectedType: "image/png", parser: "image", family: "image" };
    }
    if (startsWith(bytes, Buffer.from([0xff, 0xd8, 0xff]))) {
      return { detectedType: "image/jpeg", parser: "image", family: "image" };
    }
    if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) {
      return { detectedType: "image/gif", parser: "image", family: "image" };
    }
    if (startsWith(bytes, "PK\u0003\u0004") || startsWith(bytes, "PK\u0005\u0006")) {
      const archive = await SafeZip.open(path, DEFAULT_LIMITS);
      const names = new Set(archive.entries.map((entry) => entry.name));
      if (names.has("[Content_Types].xml") && names.has("word/document.xml")) {
        return {
          detectedType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          parser: "docx",
          family: "docx-section"
        };
      }
      if (names.has("[Content_Types].xml") && names.has("ppt/presentation.xml")) {
        return {
          detectedType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          parser: "pptx",
          family: "pptx-slide"
        };
      }
      if (names.has("[Content_Types].xml") && names.has("xl/workbook.xml")) {
        return {
          detectedType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          parser: "xlsx",
          family: "xlsx-sheet"
        };
      }
      return { detectedType: "application/zip", parser: "safe-zip", family: "archive-entry" };
    }
    if (startsWith(bytes, LEGACY_COMPOUND_MAGIC)) {
      const legacyType = lowerName.endsWith(".doc")
        ? "application/msword"
        : lowerName.endsWith(".ppt")
          ? "application/vnd.ms-powerpoint"
          : lowerName.endsWith(".xls")
            ? "application/vnd.ms-excel"
            : "application/x-ole-storage";
      return { detectedType: legacyType, parser: "legacy-unsupported", family: "binary" };
    }
    if (looksLikeText(bytes)) return { detectedType: "text/plain", parser: "text", family: "text" };
    return { detectedType: "application/octet-stream", parser: "binary", family: "binary" };
  } finally {
    await handle.close();
  }
}
