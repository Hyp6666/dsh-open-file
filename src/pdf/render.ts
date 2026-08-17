import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";

import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

import type { OpenFileLimits } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import { withTimeout } from "../async/timeout.js";
import { loadPdf } from "./document.js";

export interface PdfRenderResult {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png";
  readonly source_sha256: string;
  readonly artifact_sha256: string;
}

function installCanvasPrimitives(): void {
  const target = globalThis as unknown as {
    DOMMatrix?: unknown;
    ImageData?: unknown;
    Path2D?: unknown;
  };
  target.DOMMatrix ??= DOMMatrix;
  target.ImageData ??= ImageData;
  target.Path2D ??= Path2D;
}

export async function renderPdfPage(input: {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly page: number;
  readonly scale: number;
  readonly sourceSha256: string;
  readonly limits: Readonly<OpenFileLimits>;
}): Promise<PdfRenderResult> {
  if (!Number.isSafeInteger(input.page) || input.page < 1 || !Number.isFinite(input.scale) || input.scale <= 0 || input.scale > 8) {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", "The PDF render arguments are invalid.");
  }
  installCanvasPrimitives();
  const loaded = await loadPdf(input.sourcePath, input.limits);
  try {
    if (input.page > loaded.document.numPages) {
      throw new OpenFileError("FILE_PART_NOT_FOUND", "The requested PDF page does not exist.");
    }
    const page = await loaded.document.getPage(input.page);
    const viewport = page.getViewport({ scale: input.scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > input.limits.maxRenderPixels
    ) {
      throw new OpenFileError("FILE_RENDER_FAILED", "The rendered page exceeds the pixel limit.");
    }
    const canvas = createCanvas(width, height);
    const task = page.render({
      canvas: null,
      canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
      viewport
    });
    await withTimeout(task.promise, input.limits.renderTimeoutMs, "FILE_RENDER_FAILED", () => task.cancel());
    const bytes = canvas.toBuffer("image/png");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(input.outputPath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(input.outputPath, { force: true }).catch(() => undefined);
      throw new OpenFileError("FILE_RENDER_FAILED", "The rendered artifact could not be stored.", undefined, {
        cause: error
      });
    }
    return Object.freeze({
      page: input.page,
      width,
      height,
      mimeType: "image/png",
      source_sha256: input.sourceSha256,
      artifact_sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } catch (error) {
    if (error instanceof OpenFileError) throw error;
    throw new OpenFileError("FILE_RENDER_FAILED", "The PDF page could not be rendered.", undefined, {
      cause: error
    });
  } finally {
    await loaded.close().catch(() => undefined);
  }
}
