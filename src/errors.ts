import type { OpenFileErrorCode } from "./contracts.js";

export class OpenFileError extends Error {
  override readonly name = "OpenFileError";

  readonly code: OpenFileErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: OpenFileErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.details = details;
  }
}

export function referenceError(message = "The file reference is invalid."): OpenFileError {
  return new OpenFileError("FILE_REFERENCE_INVALID", message);
}
