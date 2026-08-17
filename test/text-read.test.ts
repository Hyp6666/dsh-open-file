import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPartRef } from "../src/references.js";
import { readTextPart } from "../src/files/text.js";

let root: string;
const sourceSha256 = "a".repeat(64);
const partRef = createPartRef(
  "session-a",
  "018f3f08-a9d1-7d01-9128-112233445566",
  "text",
  "source"
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-open-file-text-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("bounded text reading", () => {
  it.each([
    [Buffer.from("\ufeff第一行\nsecond", "utf8"), "UTF-8", "第一行\nsecond"],
    [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("第一行\nsecond", "utf16le")]), "UTF-16LE", "第一行\nsecond"],
    [iconv.encode("简体中文\nEnglish", "gb18030"), "GB18030", "简体中文\nEnglish"]
  ])("decodes %s without returning a BOM", async (bytes, expectedEncoding, expectedText) => {
    const path = join(root, "text.bin");
    await writeFile(path, bytes);
    const result = await readTextPart({ path, partRef, sourceSha256, maxChars: 100 });
    expect(result).toMatchObject({ text: expectedText, encoding: expectedEncoding, cursor: null });
    expect(result.locator).toEqual({ kind: "lines", start: 1, end: 2 });
  });

  it("returns a source-bound cursor and continues without overlap", async () => {
    const path = join(root, "long.txt");
    await writeFile(path, "line one\nline two\nline three", "utf8");
    const first = await readTextPart({ path, partRef, sourceSha256, maxChars: 10 });
    expect(first.text).toBe("line one\n");
    expect(first.locator).toEqual({ kind: "lines", start: 1, end: 1 });
    expect(first.cursor).toEqual(expect.any(String));
    if (first.cursor === null) throw new Error("expected a continuation cursor");

    const second = await readTextPart({
      path,
      partRef,
      sourceSha256,
      maxChars: 10,
      cursor: first.cursor
    });
    expect(second.text).toBe("line two\n");
    expect(second.locator).toEqual({ kind: "lines", start: 2, end: 2 });
  });

  it("rejects binary content and a cursor from another source", async () => {
    const path = join(root, "binary.bin");
    await writeFile(path, Buffer.from([0, 1, 2, 3]));
    await expect(readTextPart({ path, partRef, sourceSha256, maxChars: 10 })).rejects.toMatchObject({
      code: "FILE_PARSE_FAILED"
    });

    const textPath = join(root, "text.txt");
    await writeFile(textPath, "hello world", "utf8");
    const first = await readTextPart({ path: textPath, partRef, sourceSha256, maxChars: 5 });
    if (first.cursor === null) throw new Error("expected a continuation cursor");
    await expect(
      readTextPart({
        path: textPath,
        partRef,
        sourceSha256: "b".repeat(64),
        maxChars: 5,
        cursor: first.cursor
      })
    ).rejects.toMatchObject({ code: "FILE_REFERENCE_INVALID" });
  });
});
