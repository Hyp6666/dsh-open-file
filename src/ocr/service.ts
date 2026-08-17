import { open, rm } from "node:fs/promises";

import type { OpenFileLimits } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import { parsePartRef } from "../references.js";
import { withTimeout } from "../async/timeout.js";

export type OcrLanguage = "eng" | "chi_sim";
export type OcrLanguageSelection = "eng" | "chi_sim" | "eng+chi_sim" | "chi_sim+eng";

export interface OcrEngineResult {
  readonly text: string;
  readonly confidence: number;
}

export interface OcrEngine {
  recognize(
    imagePath: string,
    languages: readonly OcrLanguage[],
    signal: AbortSignal
  ): Promise<OcrEngineResult>;
}

export interface OcrResult extends OcrEngineResult {
  readonly part_ref: string;
  readonly source_sha256: string;
  readonly parser: "tesseract-local";
  readonly languages: readonly OcrLanguage[];
  readonly locator: Readonly<Record<string, string | number | boolean | null>>;
  readonly cursor: null;
}

function selectLanguages(value: string): readonly OcrLanguage[] {
  if (value === "eng") return Object.freeze(["eng"]);
  if (value === "chi_sim") return Object.freeze(["chi_sim"]);
  if (value === "eng+chi_sim" || value === "chi_sim+eng") {
    return Object.freeze(["eng", "chi_sim"]);
  }
  throw new OpenFileError("FILE_INVALID_ARGUMENT", "OCR supports only eng and chi_sim.");
}

async function storeResult(path: string, result: OcrResult): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw new OpenFileError("FILE_OCR_FAILED", "The OCR result could not be stored.", undefined, {
      cause: error
    });
  }
}

export class OcrService {
  private readonly engine: OcrEngine;

  constructor(engine: OcrEngine) {
    this.engine = engine;
  }

  async run(input: {
    readonly imagePath: string;
    readonly outputPath: string;
    readonly partRef: string;
    readonly sourceSha256: string;
    readonly languages: string;
    readonly locator: Readonly<Record<string, string | number | boolean | null>>;
    readonly limits: Readonly<OpenFileLimits>;
    readonly signal?: AbortSignal;
  }): Promise<OcrResult> {
    parsePartRef(input.partRef);
    if (!/^[a-f0-9]{64}$/u.test(input.sourceSha256)) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The OCR source hash is invalid.");
    }
    const languages = selectLanguages(input.languages);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    try {
      const recognized = await withTimeout(
        this.engine.recognize(input.imagePath, languages, controller.signal),
        input.limits.ocrTimeoutMs,
        "FILE_OCR_FAILED",
        () => controller.abort()
      );
      if (controller.signal.aborted) {
        throw new OpenFileError("FILE_ABORTED", "The OCR operation was aborted.");
      }
      const result: OcrResult = Object.freeze({
        text: recognized.text,
        confidence: recognized.confidence,
        part_ref: input.partRef,
        source_sha256: input.sourceSha256,
        parser: "tesseract-local",
        languages,
        locator: Object.freeze({ ...input.locator }),
        cursor: null
      });
      await storeResult(input.outputPath, result);
      return result;
    } catch (error) {
      if (error instanceof OpenFileError) throw error;
      throw new OpenFileError("FILE_OCR_FAILED", "Local OCR failed.", undefined, { cause: error });
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }
}
