import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import type { OpenFileErrorCode } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import type { UploadService } from "../upload/service.js";
import {
  assertExactKeys,
  numberField,
  readBoundedJson,
  stringField
} from "./body.js";
import { requireSameOrigin, requireSameOriginNavigation } from "./origin.js";

const BASE = "/dsh-open-file/v1";

const HTTP_STATUS: Readonly<Record<OpenFileErrorCode, number>> = Object.freeze({
  FILE_INVALID_ARGUMENT: 400,
  FILE_REFERENCE_INVALID: 400,
  FILE_SESSION_MISMATCH: 403,
  FILE_WORKSPACE_UNAVAILABLE: 503,
  FILE_WORKSPACE_NOT_WRITABLE: 507,
  FILE_UPLOAD_TOO_LARGE: 413,
  FILE_UPLOAD_INCOMPLETE: 409,
  FILE_TYPE_UNSUPPORTED: 415,
  FILE_LEGACY_FORMAT_UNSUPPORTED: 415,
  FILE_ARCHIVE_LIMIT_EXCEEDED: 422,
  FILE_PARSE_FAILED: 422,
  FILE_PART_NOT_FOUND: 404,
  FILE_OCR_FAILED: 422,
  FILE_RENDER_FAILED: 422,
  FILE_ABORTED: 499,
  FILE_INTERNAL: 500,
  FILE_WEB_COMPATIBILITY: 500
});

function contentType(request: IncomingMessage): string {
  return request.headers["content-type"]?.toLowerCase().trim() ?? "";
}

function requireJson(request: IncomingMessage): void {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType(request))) {
    throw new OpenFileError("FILE_TYPE_UNSUPPORTED", "Content-Type must be application/json.");
  }
}

function requireBinary(request: IncomingMessage): void {
  if (contentType(request) !== "application/octet-stream") {
    throw new OpenFileError(
      "FILE_TYPE_UNSUPPORTED",
      "Content-Type must be application/octet-stream."
    );
  }
}

function sendJson(response: ServerResponse, status: number, value?: unknown): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (value === undefined) {
    response.end();
    return;
  }
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(bytes.length));
  response.end(bytes);
}

const INLINE_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "text/plain"
]);

function encodedFilename(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (character) =>
    `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ""}`
  );
}

function contentDisposition(mode: "inline" | "attachment", displayName: string): string {
  const fallback = displayName.replace(/[^\x20-\x7e]|["\\]/gu, "_") || "file";
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodedFilename(displayName)}`;
}

async function sendSource(
  uploads: UploadService,
  url: URL,
  response: ServerResponse
): Promise<void> {
  const source = await uploads.resolveSource({
    sessionId: url.searchParams.get("sessionId") ?? "",
    fileRef: url.searchParams.get("fileRef") ?? ""
  });
  const inline = INLINE_TYPES.has(source.metadata.detectedType);
  response.statusCode = 200;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", source.metadata.displayName));
  response.setHeader(
    "Content-Type",
    source.metadata.detectedType === "text/plain"
      ? "text/plain; charset=utf-8"
      : inline
        ? source.metadata.detectedType
        : "application/octet-stream"
  );
  response.setHeader("Content-Length", String(source.metadata.size));
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  await pipeline(createReadStream(source.path), response);
}

function method(response: ServerResponse, allowed: string): void {
  response.setHeader("Allow", allowed);
  sendJson(response, 405, {
    error: { code: "FILE_INVALID_ARGUMENT", message: "The HTTP method is not allowed." }
  });
}

function publicError(error: unknown): OpenFileError {
  return error instanceof OpenFileError
    ? error
    : new OpenFileError("FILE_INTERNAL", "The file operation failed.", undefined, { cause: error });
}

function uploadMatch(pathname: string, suffix = ""): RegExpMatchArray | null {
  return pathname.match(
    new RegExp(`^${BASE.replaceAll("/", "\\/")}\\/uploads\\/([A-Za-z0-9_-]{1,128})${suffix}$`, "u")
  );
}

async function handle(
  uploads: UploadService,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dsh.invalid");

  if (url.pathname === `${BASE}/attachments/content`) {
    if (request.method !== "GET") return method(response, "GET");
    requireSameOriginNavigation(request);
    await sendSource(uploads, url, response);
    return;
  }

  requireSameOrigin(request);

  if (url.pathname === `${BASE}/uploads/prepare`) {
    if (request.method !== "POST") return method(response, "POST");
    requireJson(request);
    const body = await readBoundedJson(request, uploads.limits.maxJsonBytes);
    assertExactKeys(body, ["sessionId", "name", "size"], ["declaredType"]);
    const declared = body.declaredType;
    if (declared !== undefined && declared !== null && typeof declared !== "string") {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "declaredType must be a string or null.");
    }
    const prepareInput = {
      sessionId: stringField(body, "sessionId"),
      name: stringField(body, "name"),
      size: numberField(body, "size")
    };
    const prepared = await uploads.prepare(
      declared === undefined ? prepareInput : { ...prepareInput, declaredType: declared }
    );
    const session = encodeURIComponent(stringField(body, "sessionId"));
    const id = encodeURIComponent(prepared.uploadId);
    sendJson(response, 201, {
      ...prepared,
      putUrl: `${BASE}/uploads/${id}?sessionId=${session}`,
      commitUrl: `${BASE}/uploads/${id}/commit`,
      deleteUrl: `${BASE}/uploads/${id}?sessionId=${session}`
    });
    return;
  }

  const commit = uploadMatch(url.pathname, "\\/commit");
  if (commit !== null) {
    if (request.method !== "POST") return method(response, "POST");
    requireJson(request);
    const body = await readBoundedJson(request, uploads.limits.maxJsonBytes);
    assertExactKeys(body, ["sessionId"], ["expectedSha256"]);
    const expected = body.expectedSha256;
    if (expected !== undefined && typeof expected !== "string") {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "expectedSha256 must be a string.");
    }
    const commitInput = {
      sessionId: stringField(body, "sessionId"),
      uploadId: commit[1] ?? ""
    };
    const result = await uploads.commit(
      expected === undefined ? commitInput : { ...commitInput, expectedSha256: expected }
    );
    sendJson(response, 201, result);
    return;
  }

  const upload = uploadMatch(url.pathname);
  if (upload !== null) {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (request.method === "PUT") {
      requireBinary(request);
      const result = await uploads.write({
        sessionId,
        uploadId: upload[1] ?? "",
        bytes: request
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "DELETE") {
      await uploads.cancel({ sessionId, uploadId: upload[1] ?? "" });
      sendJson(response, 204);
      return;
    }
    return method(response, "PUT, DELETE");
  }

  if (url.pathname === `${BASE}/attachments/resolve`) {
    if (request.method !== "POST") return method(response, "POST");
    requireJson(request);
    const body = await readBoundedJson(request, uploads.limits.maxJsonBytes);
    assertExactKeys(body, ["sessionId", "fileRef"]);
    sendJson(
      response,
      200,
      await uploads.resolve({
        sessionId: stringField(body, "sessionId"),
        fileRef: stringField(body, "fileRef")
      })
    );
    return;
  }

  const adopt = url.pathname.match(
    new RegExp(`^${BASE.replaceAll("/", "\\/")}\\/attachments\\/([0-9a-f-]{36})\\/adopt$`, "iu")
  );
  if (adopt !== null) {
    if (request.method !== "POST") return method(response, "POST");
    requireJson(request);
    const body = await readBoundedJson(request, uploads.limits.maxJsonBytes);
    assertExactKeys(body, ["sessionId"]);
    await uploads.adopt({
      sessionId: stringField(body, "sessionId"),
      fileId: adopt[1] ?? ""
    });
    sendJson(response, 204);
    return;
  }

  sendJson(response, 404, {
    error: { code: "FILE_PART_NOT_FOUND", message: "The endpoint does not exist." }
  });
}

export function createOpenFileHttpHandler(uploads: UploadService): RequestListener {
  return (request, response) => {
    void handle(uploads, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const safe = publicError(error);
      sendJson(response, HTTP_STATUS[safe.code], {
        error: { code: safe.code, message: safe.message }
      });
    });
  };
}
