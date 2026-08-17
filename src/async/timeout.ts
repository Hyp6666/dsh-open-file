import { OpenFileError } from "../errors.js";

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: "FILE_PARSE_FAILED" | "FILE_RENDER_FAILED" | "FILE_OCR_FAILED",
  cancel?: () => void | Promise<void>
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(cancel?.()).finally(() => {
        reject(new OpenFileError(code, "The file operation timed out."));
      });
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
