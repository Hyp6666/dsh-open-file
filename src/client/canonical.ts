import { OpenFileError } from "../errors.js";

const ORIGINAL = Symbol.for("cordis.original");

export function canonicalService(value: unknown): object {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new OpenFileError("FILE_WEB_COMPATIBILITY", "The rc.6 client service is unavailable.");
  }
  let current = value;
  const visited = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(current)) {
      throw new OpenFileError("FILE_WEB_COMPATIBILITY", "The rc.6 client service proxy is cyclic.");
    }
    visited.add(current);
    const original = (current as Record<PropertyKey, unknown>)[ORIGINAL];
    if ((typeof original !== "object" && typeof original !== "function") || original === null) {
      return current;
    }
    current = original;
  }
  throw new OpenFileError("FILE_WEB_COMPATIBILITY", "The rc.6 client service proxy is too deep.");
}
