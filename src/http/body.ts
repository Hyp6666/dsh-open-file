import type { IncomingMessage } from "node:http";

import { OpenFileError } from "../errors.js";

export async function readBoundedJson(
  request: IncomingMessage,
  maximumBytes: number
): Promise<Record<string, unknown>> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The Content-Length header is invalid.");
    }
    if (length > maximumBytes) {
      throw new OpenFileError("FILE_UPLOAD_TOO_LARGE", "The JSON request body is too large.");
    }
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    received += chunk.length;
    if (received > maximumBytes) {
      throw new OpenFileError("FILE_UPLOAD_TOO_LARGE", "The JSON request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The JSON request body must be an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OpenFileError) throw error;
    throw new OpenFileError("FILE_INVALID_ARGUMENT", "The JSON request body is invalid.", undefined, {
      cause: error
    });
  }
}

export function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const accepted = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !(key in value)) || keys.some((key) => !accepted.has(key))) {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", "The request fields are invalid.");
  }
}

export function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", `${key} must be a string.`);
  }
  return field;
}

export function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number") {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", `${key} must be a number.`);
  }
  return field;
}
