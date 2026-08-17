import { readFile } from "node:fs/promises";

import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api.js";

import type { OpenFileLimits } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import { withTimeout } from "../async/timeout.js";

export interface LoadedPdf {
  readonly document: PDFDocumentProxy;
  close(): Promise<void>;
}

export async function loadPdf(path: string, limits: Readonly<OpenFileLimits>): Promise<LoadedPdf> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The PDF source could not be read.", undefined, {
      cause: error
    });
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true
  });
  try {
    const document = await withTimeout(
      task.promise,
      limits.parseTimeoutMs,
      "FILE_PARSE_FAILED",
      () => task.destroy()
    );
    if (document.numPages > limits.maxPdfPages) {
      await task.destroy();
      throw new OpenFileError("FILE_PARSE_FAILED", "The PDF page-count limit is exceeded.");
    }
    return Object.freeze({
      document,
      close: () => task.destroy()
    });
  } catch (error) {
    await task.destroy().catch(() => undefined);
    if (error instanceof OpenFileError) throw error;
    const named = error instanceof Error ? error.name : "";
    const message = named === "PasswordException" ? "The PDF is encrypted or requires a password." : "The PDF is malformed.";
    throw new OpenFileError("FILE_PARSE_FAILED", message, undefined, { cause: error });
  }
}
