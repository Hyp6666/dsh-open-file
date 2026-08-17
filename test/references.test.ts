import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createAttachmentRef,
  createCursor,
  createPartRef,
  parseAttachmentRef,
  parseCursor,
  parsePartRef,
  sessionDirectoryName
} from "../src/references.js";
import { OpenFileError } from "../src/errors.js";

const sessionId = "session/中文 ?#";
const fileId = "018f3f08-a9d1-7d01-9128-112233445566";

describe("traceable references", () => {
  it("round-trips an attachment ref without exposing a filesystem path", () => {
    const ref = createAttachmentRef(sessionId, fileId);
    expect(ref).toBe(
      "dsh-open-file://attachment/v1/session%2F%E4%B8%AD%E6%96%87%20%3F%23/018f3f08-a9d1-7d01-9128-112233445566"
    );
    expect(parseAttachmentRef(ref)).toEqual({ version: 1, sessionId, fileId });
    expect(ref).not.toContain(".dsh");
  });

  it("round-trips a part ref with a structured locator id", () => {
    const ref = createPartRef(sessionId, fileId, "pdf-page", "page:12");
    expect(parsePartRef(ref)).toEqual({
      version: 1,
      sessionId,
      fileId,
      family: "pdf-page",
      partId: "page:12"
    });
  });

  it.each([
    "https://example.test/file",
    "dsh-open-file://attachment/v2/s/f",
    "dsh-open-file://attachment/v1/s/../f",
    "dsh-open-file://part/v1/s/f/pdf-page",
    "dsh-open-file://part/v1/s/f/%2F/x",
    ""
  ])("rejects malformed or unsafe refs: %s", (value) => {
    const parse = (): unknown =>
      value.includes("/part/") ? parsePartRef(value) : parseAttachmentRef(value);
    expect(parse).toThrowError(OpenFileError);
    try {
      parse();
    } catch (error) {
      expect((error as OpenFileError).code).toBe("FILE_REFERENCE_INVALID");
    }
  });

  it("uses a stable SHA-256 directory instead of the raw session id", () => {
    const directory = sessionDirectoryName(sessionId);
    expect(directory).toBe(createHash("sha256").update(sessionId).digest("hex"));
    expect(directory).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("round-trips and binds an opaque cursor to source and part", () => {
    const sourceSha256 = "b".repeat(64);
    const partRef = createPartRef(sessionId, fileId, "text", "body");
    const cursor = createCursor({ partRef, sourceSha256, offset: 4096 });
    expect(cursor).not.toContain(partRef);
    expect(parseCursor(cursor, { partRef, sourceSha256 })).toEqual({
      version: 1,
      partRef,
      sourceSha256,
      offset: 4096
    });
    expect(() => parseCursor(cursor, { partRef, sourceSha256: "c".repeat(64) })).toThrowError(
      /cursor/i
    );
  });

  it("rejects tampered and non-integer cursors", () => {
    const sourceSha256 = "d".repeat(64);
    const partRef = createPartRef(sessionId, fileId, "text", "body");
    const cursor = createCursor({ partRef, sourceSha256, offset: 2 });
    expect(() => parseCursor(`${cursor}x`, { partRef, sourceSha256 })).toThrowError(OpenFileError);

    const forged = Buffer.from(
      JSON.stringify({ v: 1, p: partRef, h: sourceSha256, o: 2.5 }),
      "utf8"
    ).toString("base64url");
    expect(() => parseCursor(forged, { partRef, sourceSha256 })).toThrowError(OpenFileError);
  });
});
