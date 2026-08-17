export const STABLE_ERROR_CODES = [
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
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

export const CLIENT_COMPATIBILITY_ERROR_CODE = "FILE_WEB_COMPATIBILITY" as const;

export type OpenFileErrorCode = StableErrorCode | typeof CLIENT_COMPATIBILITY_ERROR_CODE;

export const FIXED_TOOL_FOOTER =
  "Please continue to choose any callable tools or answer directly as appropriate.";

export interface OpenFileLimits {
  readonly maxFileBytes: number;
  readonly maxDraftFiles: number;
  readonly maxDraftBytes: number;
  readonly maxJsonBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxArchiveEntryBytes: number;
  readonly maxArchiveExpandedBytes: number;
  readonly maxArchiveRatio: number;
  readonly maxArchiveDepth: number;
  readonly parseTimeoutMs: number;
  readonly renderTimeoutMs: number;
  readonly ocrTimeoutMs: number;
  readonly maxRenderPixels: number;
  readonly maxPdfPages: number;
  readonly uploadTimeoutMs: number;
  readonly defaultReadChars: number;
  readonly maxReadChars: number;
}

export const DEFAULT_LIMITS: Readonly<OpenFileLimits> = Object.freeze({
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
  maxPdfPages: 10_000,
  uploadTimeoutMs: 300_000,
  defaultReadChars: 20_000,
  maxReadChars: 100_000
});

export type Locator = Readonly<Record<string, string | number | boolean | null>>;

export interface ToolEnvelope<T> {
  readonly ok: true;
  readonly file_ref: string;
  readonly part_ref?: string;
  readonly source_sha256: string;
  readonly parser: string;
  readonly locator: Locator;
  readonly cursor: string | null;
  readonly data: T;
  readonly note: typeof FIXED_TOOL_FOOTER;
}
