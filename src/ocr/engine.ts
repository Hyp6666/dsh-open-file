import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createWorker, OEM } from "tesseract.js";

import { OpenFileError } from "../errors.js";
import type { OcrEngine, OcrEngineResult, OcrLanguage } from "./service.js";

export class TesseractLocalEngine implements OcrEngine {
  private readonly languagePath: string;

  constructor(languagePath = fileURLToPath(new URL("../tessdata/", import.meta.url))) {
    this.languagePath = languagePath;
  }

  async recognize(
    imagePath: string,
    languages: readonly OcrLanguage[],
    signal: AbortSignal
  ): Promise<OcrEngineResult> {
    try {
      await access(this.languagePath);
    } catch (error) {
      throw new OpenFileError(
        "FILE_OCR_FAILED",
        "The packaged local OCR language data is unavailable.",
        undefined,
        { cause: error }
      );
    }
    const worker = await createWorker([...languages], OEM.LSTM_ONLY, {
      langPath: this.languagePath,
      gzip: true,
      cacheMethod: "none",
      logger: () => undefined
    });
    const abort = (): void => {
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw new OpenFileError("FILE_ABORTED", "The OCR operation was aborted.");
      const result = await worker.recognize(imagePath);
      if (signal.aborted) throw new OpenFileError("FILE_ABORTED", "The OCR operation was aborted.");
      return Object.freeze({ text: result.data.text, confidence: result.data.confidence });
    } finally {
      signal.removeEventListener("abort", abort);
      await worker.terminate().catch(() => undefined);
    }
  }
}
