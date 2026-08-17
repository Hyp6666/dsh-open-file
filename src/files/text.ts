import { readFile } from "node:fs/promises";

import { detect } from "chardet";
import iconv from "iconv-lite";

import { OpenFileError } from "../errors.js";
import { createCursor, parseCursor } from "../references.js";

export interface TextReadResult {
  readonly text: string;
  readonly encoding: string;
  readonly locator: {
    readonly kind: "lines";
    readonly start: number;
    readonly end: number;
  };
  readonly cursor: string | null;
}

function validUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Buffer): { text: string; encoding: string } {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return { text: bytes.subarray(3).toString("utf8"), encoding: "UTF-8" };
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return { text: bytes.subarray(2).toString("utf16le"), encoding: "UTF-16LE" };
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return { text: iconv.decode(bytes.subarray(2), "utf16-be"), encoding: "UTF-16BE" };
  }
  if (bytes.includes(0)) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The selected part is not text.");
  }
  if (validUtf8(bytes)) return { text: bytes.toString("utf8"), encoding: "UTF-8" };

  const detected = detect(bytes);
  const gb18030 = iconv.decode(bytes, "gb18030");
  const gbRoundTrip = iconv.encode(gb18030, "gb18030").equals(bytes);
  const gbCjkCharacters = [...gb18030].filter((character) => /[\u3400-\u9fff]/u.test(character)).length;
  if (gbRoundTrip && gbCjkCharacters > 0) {
    return { text: gb18030, encoding: "GB18030" };
  }
  if (detected === null || !iconv.encodingExists(detected)) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The text encoding could not be determined.");
  }
  const label = detected.toUpperCase().replace("GB18030", "GB18030");
  return { text: iconv.decode(bytes, detected), encoding: label };
}

function endAtLineBoundary(text: string, start: number, maximum: number): number {
  const tentative = Math.min(text.length, start + maximum);
  if (tentative === text.length) return tentative;
  const boundary = text.lastIndexOf("\n", tentative - 1);
  return boundary >= start ? boundary + 1 : tentative;
}

function lineNumber(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

export async function readTextPart(input: {
  readonly path: string;
  readonly partRef: string;
  readonly sourceSha256: string;
  readonly maxChars: number;
  readonly cursor?: string;
}): Promise<TextReadResult> {
  if (!Number.isSafeInteger(input.maxChars) || input.maxChars < 1) {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", "maxChars must be a positive integer.");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(input.path);
  } catch (error) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The text source could not be read.", undefined, {
      cause: error
    });
  }
  const decoded = decodeText(bytes);
  const start =
    input.cursor === undefined
      ? 0
      : parseCursor(input.cursor, {
          partRef: input.partRef,
          sourceSha256: input.sourceSha256
        }).offset;
  if (start > decoded.text.length) {
    throw new OpenFileError("FILE_REFERENCE_INVALID", "The cursor is outside the selected part.");
  }
  const end = endAtLineBoundary(decoded.text, start, input.maxChars);
  const text = decoded.text.slice(start, end);
  const firstLine = lineNumber(decoded.text, start);
  const newlineCount = [...text].filter((character) => character === "\n").length;
  const lastLine = text.endsWith("\n")
    ? Math.max(firstLine, firstLine + newlineCount - 1)
    : firstLine + newlineCount;
  return Object.freeze({
    text,
    encoding: decoded.encoding,
    locator: Object.freeze({ kind: "lines" as const, start: firstLine, end: lastLine }),
    cursor:
      end < decoded.text.length
        ? createCursor({ partRef: input.partRef, sourceSha256: input.sourceSha256, offset: end })
        : null
  });
}
