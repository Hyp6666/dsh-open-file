import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIMITS,
  FIXED_TOOL_FOOTER,
  STABLE_ERROR_CODES,
  type ToolEnvelope
} from "../src/contracts.js";

describe("public contracts", () => {
  it("keeps the documented stable error family exact", () => {
    expect(STABLE_ERROR_CODES).toEqual([
      "FILE_INVALID_ARGUMENT",
      "FILE_REFERENCE_INVALID",
      "FILE_SESSION_MISMATCH",
      "FILE_WORKSPACE_UNAVAILABLE",
      "FILE_WORKSPACE_NOT_WRITABLE",
      "FILE_UPLOAD_TOO_LARGE",
      "FILE_UPLOAD_INCOMPLETE",
      "FILE_TYPE_UNSUPPORTED",
      "FILE_LEGACY_FORMAT_UNSUPPORTED",
      "FILE_ARCHIVE_LIMIT_EXCEEDED",
      "FILE_PARSE_FAILED",
      "FILE_PART_NOT_FOUND",
      "FILE_OCR_FAILED",
      "FILE_RENDER_FAILED",
      "FILE_ABORTED",
      "FILE_INTERNAL"
    ]);
  });

  it("uses bounded non-platform-specific defaults", () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      maxFileBytes: 256 * 1024 * 1024,
      maxDraftFiles: 20,
      maxDraftBytes: 512 * 1024 * 1024,
      maxJsonBytes: 64 * 1024,
      maxArchiveEntries: 10_000,
      maxArchiveEntryBytes: 64 * 1024 * 1024,
      maxArchiveExpandedBytes: 512 * 1024 * 1024,
      maxArchiveRatio: 100,
      maxArchiveDepth: 2,
      parseTimeoutMs: 30_000,
      renderTimeoutMs: 30_000,
      ocrTimeoutMs: 120_000,
      maxRenderPixels: 40_000_000,
      defaultReadChars: 20_000,
      maxReadChars: 100_000
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it("keeps next-step choice entirely with the calling model", () => {
    expect(FIXED_TOOL_FOOTER).toBe(
      "Please continue to choose any callable tools or answer directly as appropriate."
    );
  });

  it("defines a JSON-serializable traced tool envelope", () => {
    const result: ToolEnvelope<{ text: string }> = {
      ok: true,
      file_ref: "dsh-open-file://attachment/v1/s/f",
      source_sha256: "a".repeat(64),
      parser: "text/plain",
      locator: { kind: "lines", start: 1, end: 1 },
      cursor: null,
      data: { text: "hello" },
      note: FIXED_TOOL_FOOTER
    };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
