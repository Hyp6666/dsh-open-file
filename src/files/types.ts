export interface ParsedPart {
  readonly part_ref: string;
  readonly kind: string;
  readonly locator: Readonly<Record<string, string | number | boolean | null>>;
  readonly parser: string;
  readonly source_sha256: string;
  readonly text?: string;
}

export interface ParseContext {
  readonly sessionId: string;
  readonly fileId: string;
  readonly sourceSha256: string;
}
