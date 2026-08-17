import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIMITS } from "../src/contracts.js";
import { createPartRef } from "../src/references.js";
import { OcrService, type OcrEngine } from "../src/ocr/service.js";

let root: string;
const partRef = createPartRef(
  "session-a",
  "018f3f08-a9d1-7d01-9128-112233445566",
  "image",
  "source"
);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-open-file-ocr-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("explicit local OCR service", () => {
  it("persists English/Simplified-Chinese OCR with complete provenance", async () => {
    const imagePath = join(root, "image.png");
    const outputPath = join(root, "ocr.json");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const recognize = vi.fn<OcrEngine["recognize"]>().mockResolvedValue({
      text: "Hello 简体中文",
      confidence: 91.5
    });
    const service = new OcrService({ recognize });
    const result = await service.run({
      imagePath,
      outputPath,
      partRef,
      sourceSha256: "a".repeat(64),
      languages: "eng+chi_sim",
      locator: { kind: "image", index: 1 },
      limits: DEFAULT_LIMITS
    });
    expect(recognize).toHaveBeenCalledWith(imagePath, ["eng", "chi_sim"], expect.any(AbortSignal));
    expect(result).toMatchObject({
      text: "Hello 简体中文",
      confidence: 91.5,
      part_ref: partRef,
      source_sha256: "a".repeat(64),
      parser: "tesseract-local",
      languages: ["eng", "chi_sim"],
      locator: { kind: "image", index: 1 },
      cursor: null
    });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(result);
  });

  it.each(["eng", "chi_sim", "chi_sim+eng"] as const)("accepts local language selection %s", async (languages) => {
    const imagePath = join(root, `${languages}.png`);
    await writeFile(imagePath, "image", "utf8");
    const recognize = vi.fn<OcrEngine["recognize"]>().mockResolvedValue({ text: "ok", confidence: 80 });
    const service = new OcrService({ recognize });
    const result = await service.run({
      imagePath,
      outputPath: join(root, `${languages}.json`),
      partRef,
      sourceSha256: "a".repeat(64),
      languages,
      locator: { kind: "image" },
      limits: DEFAULT_LIMITS
    });
    expect(result.languages).toEqual(
      languages.includes("+") ? ["eng", "chi_sim"] : [languages]
    );
  });

  it("rejects unsupported languages without invoking the engine", async () => {
    const recognize = vi.fn<OcrEngine["recognize"]>();
    const service = new OcrService({ recognize });
    await expect(
      service.run({
        imagePath: join(root, "x"),
        outputPath: join(root, "x.json"),
        partRef,
        sourceSha256: "a".repeat(64),
        languages: "fra",
        locator: { kind: "image" },
        limits: DEFAULT_LIMITS
      })
    ).rejects.toMatchObject({ code: "FILE_INVALID_ARGUMENT" });
    expect(recognize).not.toHaveBeenCalled();
  });

  it("maps timeout and engine failures to FILE_OCR_FAILED", async () => {
    const imagePath = join(root, "image.png");
    await writeFile(imagePath, "image", "utf8");
    const never = new Promise<never>(() => undefined);
    const service = new OcrService({ recognize: () => never });
    await expect(
      service.run({
        imagePath,
        outputPath: join(root, "timeout.json"),
        partRef,
        sourceSha256: "a".repeat(64),
        languages: "eng",
        locator: { kind: "image" },
        limits: { ...DEFAULT_LIMITS, ocrTimeoutMs: 10 }
      })
    ).rejects.toMatchObject({ code: "FILE_OCR_FAILED" });

    const failed = new OcrService({ recognize: () => Promise.reject(new Error("engine details")) });
    await expect(
      failed.run({
        imagePath,
        outputPath: join(root, "failed.json"),
        partRef,
        sourceSha256: "a".repeat(64),
        languages: "eng",
        locator: { kind: "image" },
        limits: DEFAULT_LIMITS
      })
    ).rejects.toMatchObject({ code: "FILE_OCR_FAILED" });
  });
});
