import { createHash } from "node:crypto";

import { referenceError } from "./errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FAMILY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const PART_ID_PATTERN = /^[\p{L}\p{N}_.:@+-]{1,256}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface AttachmentReference {
  readonly version: 1;
  readonly sessionId: string;
  readonly fileId: string;
}

export interface PartReference extends AttachmentReference {
  readonly family: string;
  readonly partId: string;
}

export interface CursorPayload {
  readonly version: 1;
  readonly partRef: string;
  readonly sourceSha256: string;
  readonly offset: number;
}

function assertSessionId(sessionId: string): void {
  const hasControlCharacter = [...sessionId].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (
    sessionId.length === 0 ||
    sessionId.length > 1024 ||
    hasControlCharacter
  ) {
    throw referenceError("The session component is invalid.");
  }
}

function assertFileId(fileId: string): void {
  if (!UUID_PATTERN.test(fileId)) {
    throw referenceError("The file component is invalid.");
  }
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value);
}

function decodeComponent(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (encodeComponent(decoded) !== value) {
      throw referenceError("The reference uses a non-canonical encoding.");
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error && error.name === "OpenFileError") {
      throw error;
    }
    throw referenceError("The reference contains an invalid encoding.");
  }
}

function parseReference(value: string, authority: "attachment" | "part"): string[] {
  if (typeof value !== "string" || value.length > 4096) {
    throw referenceError();
  }
  const prefix = `dsh-open-file://${authority}/v1/`;
  if (!value.startsWith(prefix)) {
    throw referenceError();
  }
  const suffix = value.slice(prefix.length);
  if (suffix.length === 0 || suffix.includes("?") || suffix.includes("#")) {
    throw referenceError();
  }
  return suffix.split("/");
}

export function createAttachmentRef(sessionId: string, fileId: string): string {
  assertSessionId(sessionId);
  assertFileId(fileId);
  return `dsh-open-file://attachment/v1/${encodeComponent(sessionId)}/${fileId.toLowerCase()}`;
}

export function parseAttachmentRef(value: string): AttachmentReference {
  const components = parseReference(value, "attachment");
  if (components.length !== 2) {
    throw referenceError();
  }
  const sessionId = decodeComponent(components[0] ?? "");
  const fileId = components[1] ?? "";
  assertSessionId(sessionId);
  assertFileId(fileId);
  return { version: 1, sessionId, fileId: fileId.toLowerCase() };
}

export function createPartRef(
  sessionId: string,
  fileId: string,
  family: string,
  partId: string
): string {
  assertSessionId(sessionId);
  assertFileId(fileId);
  if (!FAMILY_PATTERN.test(family) || !PART_ID_PATTERN.test(partId)) {
    throw referenceError("The part component is invalid.");
  }
  return `dsh-open-file://part/v1/${encodeComponent(sessionId)}/${fileId.toLowerCase()}/${family}/${encodeComponent(partId)}`;
}

export function parsePartRef(value: string): PartReference {
  const components = parseReference(value, "part");
  if (components.length !== 4) {
    throw referenceError();
  }
  const sessionId = decodeComponent(components[0] ?? "");
  const fileId = components[1] ?? "";
  const family = components[2] ?? "";
  const partId = decodeComponent(components[3] ?? "");
  assertSessionId(sessionId);
  assertFileId(fileId);
  if (!FAMILY_PATTERN.test(family) || !PART_ID_PATTERN.test(partId)) {
    throw referenceError("The part component is invalid.");
  }
  return { version: 1, sessionId, fileId: fileId.toLowerCase(), family, partId };
}

export function sessionDirectoryName(sessionId: string): string {
  assertSessionId(sessionId);
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

export function createCursor(input: {
  readonly partRef: string;
  readonly sourceSha256: string;
  readonly offset: number;
}): string {
  parsePartRef(input.partRef);
  if (!SHA256_PATTERN.test(input.sourceSha256) || !Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw referenceError("The cursor payload is invalid.");
  }
  const encoded = JSON.stringify({ v: 1, p: input.partRef, h: input.sourceSha256, o: input.offset });
  return Buffer.from(encoded, "utf8").toString("base64url");
}

export function parseCursor(
  cursor: string,
  expected: { readonly partRef: string; readonly sourceSha256: string }
): CursorPayload {
  try {
    if (cursor.length === 0 || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw referenceError("The cursor is invalid.");
    }
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      throw referenceError("The cursor encoding is invalid.");
    }
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null) {
      throw referenceError("The cursor payload is invalid.");
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "h,o,p,v" ||
      record.v !== 1 ||
      record.p !== expected.partRef ||
      record.h !== expected.sourceSha256 ||
      typeof record.o !== "number" ||
      !Number.isSafeInteger(record.o) ||
      record.o < 0 ||
      !SHA256_PATTERN.test(expected.sourceSha256)
    ) {
      throw referenceError("The cursor does not match the selected part.");
    }
    parsePartRef(expected.partRef);
    return {
      version: 1,
      partRef: expected.partRef,
      sourceSha256: expected.sourceSha256,
      offset: record.o
    };
  } catch (error) {
    if (error instanceof Error && error.name === "OpenFileError") {
      throw error;
    }
    throw referenceError("The cursor is invalid.");
  }
}
