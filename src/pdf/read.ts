import type { OpenFileLimits } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import type { ParsedPart, ParseContext } from "../files/types.js";
import { createPartRef } from "../references.js";
import { loadPdf } from "./document.js";

export interface PdfPageText {
  readonly page: number;
  readonly text: string;
}

export interface PdfReadResult {
  readonly parser: "pdfjs";
  readonly metadata: {
    readonly pageCount: number;
    readonly title: string | null;
    readonly author: string | null;
    readonly subject: string | null;
  };
  readonly pages: readonly PdfPageText[];
  readonly parts: readonly ParsedPart[];
  readonly text: string;
}

function metadataString(info: Record<string, unknown>, name: string): string | null {
  return typeof info[name] === "string" ? info[name] : null;
}

export async function readPdf(
  path: string,
  context: ParseContext,
  range: { readonly startPage?: number; readonly endPage?: number },
  limits: Readonly<OpenFileLimits>
): Promise<PdfReadResult> {
  const loaded = await loadPdf(path, limits);
  try {
    const start = range.startPage ?? 1;
    const end = range.endPage ?? loaded.document.numPages;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > loaded.document.numPages
    ) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The PDF page range is invalid.");
    }
    const pages: PdfPageText[] = [];
    const parts: ParsedPart[] = [];
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      const page = await loaded.document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      text = text.trim();
      pages.push(Object.freeze({ page: pageNumber, text }));
      parts.push(
        Object.freeze({
          part_ref: createPartRef(context.sessionId, context.fileId, "pdf-page", `page:${pageNumber}`),
          kind: "pdf-page",
          locator: Object.freeze({ kind: "page", page: pageNumber }),
          parser: "pdfjs",
          source_sha256: context.sourceSha256,
          text
        })
      );
    }
    const metadata = await loaded.document.getMetadata();
    const info = metadata.info as unknown as Record<string, unknown>;
    return Object.freeze({
      parser: "pdfjs",
      metadata: Object.freeze({
        pageCount: loaded.document.numPages,
        title: metadataString(info, "Title"),
        author: metadataString(info, "Author"),
        subject: metadataString(info, "Subject")
      }),
      pages: Object.freeze(pages),
      parts: Object.freeze(parts),
      text: pages.map((page) => `## Page ${page.page}\n\n${page.text}`).join("\n\n")
    });
  } catch (error) {
    if (error instanceof OpenFileError) throw error;
    throw new OpenFileError("FILE_PARSE_FAILED", "The PDF text could not be read.", undefined, {
      cause: error
    });
  } finally {
    await loaded.close().catch(() => undefined);
  }
}
