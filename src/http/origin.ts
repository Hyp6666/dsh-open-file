import type { IncomingMessage } from "node:http";

import { OpenFileError } from "../errors.js";

export function requireSameOrigin(request: IncomingMessage): void {
  const originValue = request.headers.origin;
  const host = request.headers.host;
  if (typeof originValue !== "string" || typeof host !== "string") {
    throw new OpenFileError("FILE_SESSION_MISMATCH", "A same-origin browser request is required.");
  }
  try {
    const origin = new URL(originValue);
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.host !== host) {
      throw new OpenFileError("FILE_SESSION_MISMATCH", "The request origin is not allowed.");
    }
  } catch (error) {
    if (error instanceof OpenFileError) throw error;
    throw new OpenFileError("FILE_SESSION_MISMATCH", "The request origin is invalid.", undefined, {
      cause: error
    });
  }
}

export function requireSameOriginNavigation(request: IncomingMessage): void {
  if (request.headers.origin !== undefined) {
    requireSameOrigin(request);
    return;
  }
  const site = request.headers["sec-fetch-site"];
  if (site === "same-origin" || site === "none" || site === undefined) return;
  throw new OpenFileError("FILE_SESSION_MISMATCH", "A same-origin browser request is required.");
}
