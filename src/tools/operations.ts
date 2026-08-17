import { randomUUID } from "node:crypto";

import type { JsonValue } from "@deepseek-ai/dsh-tools";

import { SafeZip } from "../archive/safe-zip.js";
import { DEFAULT_LIMITS, type OpenFileLimits, type ToolEnvelope } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import { readTextPart } from "../files/text.js";
import { readDocx } from "../office/docx.js";
import { readPptx } from "../office/pptx.js";
import { attribute, startTags } from "../office/xml.js";
import { readXlsx } from "../office/xlsx.js";
import { TesseractLocalEngine } from "../ocr/engine.js";
import { OcrService, type OcrEngine } from "../ocr/service.js";
import { loadPdf } from "../pdf/document.js";
import { readPdf } from "../pdf/read.js";
import { renderPdfPage } from "../pdf/render.js";
import {
  createPartRef,
  parseAttachmentRef,
  parsePartRef
} from "../references.js";
import {
  WorkspaceRepository,
  type StoredFileMetadata,
  type StoredManifest
} from "../storage/repository.js";
import type {
  FileToolOperations,
  InspectArguments,
  OcrArguments,
  ReadArguments,
  RenderArguments
} from "./index.js";
import type { ToolOperationContext } from "./context.js";

type Data = Record<string, JsonValue>;
type Result = Omit<ToolEnvelope<Data>, "note">;

interface ManifestPart {
  readonly part_ref: string;
  readonly kind: string;
  readonly locator: Record<string, string | number | boolean | null>;
  readonly parser: string;
  readonly source_sha256: string;
  readonly artifact?: string;
}

export interface FileOperationsOptions {
  readonly limits?: Readonly<OpenFileLimits>;
  readonly ocrEngine?: OcrEngine;
}

function jsonRecord(value: object): Data {
  return JSON.parse(JSON.stringify(value)) as Data;
}

function part(
  metadata: StoredFileMetadata,
  family: string,
  id: string,
  kind: string,
  locator: ManifestPart["locator"],
  parser: string,
  artifact?: string
): ManifestPart {
  return Object.freeze({
    part_ref: createPartRef(metadata.sessionId, metadata.fileId, family, id),
    kind,
    locator: Object.freeze(locator),
    parser,
    source_sha256: metadata.sourceSha256,
    ...(artifact === undefined ? {} : { artifact })
  });
}

function manifestParts(manifest: StoredManifest): ManifestPart[] {
  return manifest.parts.filter((candidate): candidate is ManifestPart => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const value = candidate as Record<string, unknown>;
    return (
      typeof value.part_ref === "string" &&
      typeof value.kind === "string" &&
      typeof value.parser === "string" &&
      typeof value.source_sha256 === "string" &&
      typeof value.locator === "object" &&
      value.locator !== null
    );
  });
}

function assertCurrentSession(sessionId: string, referencedSession: string): void {
  if (sessionId !== referencedSession) {
    throw new OpenFileError("FILE_SESSION_MISMATCH", "The file reference belongs to another session.");
  }
}

export class FileOperations implements FileToolOperations {
  private readonly limits: Readonly<OpenFileLimits>;
  private readonly ocrService: OcrService;

  constructor(options: FileOperationsOptions = {}) {
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    this.ocrService = new OcrService(options.ocrEngine ?? new TesseractLocalEngine());
  }

  async inspect(context: ToolOperationContext, arguments_: InspectArguments): Promise<Result> {
    const { repository, metadata } = await this.attachment(context, arguments_.file_ref);
    const manifest = await this.inspectManifest(repository, metadata);
    const parts = manifestParts(manifest);
    return Object.freeze({
      ok: true,
      file_ref: metadata.fileRef,
      source_sha256: metadata.sourceSha256,
      parser: manifest.parser,
      locator: Object.freeze({ kind: "file" }),
      cursor: null,
      data: jsonRecord({
        metadata: {
          display_name: metadata.displayName,
          size: metadata.size,
          declared_type: metadata.declaredType,
          detected_type: metadata.detectedType,
          created_at: metadata.createdAt
        },
        parts,
        summary: manifest.summary ?? {},
        warnings: manifest.warnings ?? []
      })
    });
  }

  async read(context: ToolOperationContext, arguments_: ReadArguments): Promise<Result> {
    const { repository, metadata } = await this.attachment(context, arguments_.file_ref);
    const selectedReference = parsePartRef(arguments_.part_ref);
    assertCurrentSession(context.sessionId, selectedReference.sessionId);
    if (selectedReference.fileId !== metadata.fileId) {
      throw new OpenFileError("FILE_REFERENCE_INVALID", "The part does not belong to the selected file.");
    }
    const manifest = await this.inspectManifest(repository, metadata);
    const selected = manifestParts(manifest).find((candidate) => candidate.part_ref === arguments_.part_ref);
    if (selected === undefined) throw new OpenFileError("FILE_PART_NOT_FOUND", "The selected part does not exist.");
    const maximum = Math.min(arguments_.max_chars ?? this.limits.defaultReadChars, this.limits.maxReadChars);
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "max_chars is invalid.");
    }
    const sourcePath = repository.sourcePath(metadata.fileId);
    let data: Data;
    let cursor: string | null = null;

    if (manifest.parser === "text") {
      const read = await readTextPart({
        path: sourcePath,
        partRef: selected.part_ref,
        sourceSha256: metadata.sourceSha256,
        maxChars: maximum,
        ...(arguments_.cursor === undefined ? {} : { cursor: arguments_.cursor })
      });
      data = jsonRecord({ text: read.text, encoding: read.encoding, untrusted: true });
      cursor = read.cursor;
    } else if (manifest.parser === "pdfjs") {
      const page = selected.locator.page;
      if (typeof page !== "number") throw new OpenFileError("FILE_PART_NOT_FOUND", "The PDF page locator is invalid.");
      const read = await readPdf(
        sourcePath,
        { sessionId: context.sessionId, fileId: metadata.fileId, sourceSha256: metadata.sourceSha256 },
        { startPage: page, endPage: page },
        this.limits
      );
      data = jsonRecord({ page, text: read.pages[0]?.text ?? "", metadata: read.metadata, untrusted: true });
    } else if (manifest.parser === "safe-zip") {
      const entry = selected.locator.entry;
      if (typeof entry !== "string") throw new OpenFileError("FILE_PART_NOT_FOUND", "The archive locator is invalid.");
      const bytes = await (await SafeZip.open(sourcePath, this.limits)).readEntry(entry);
      const validText = !bytes.includes(0) && new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      data = jsonRecord({
        entry,
        ...(validText === false
          ? { byte_length: bytes.length, hex_preview: bytes.subarray(0, Math.min(256, bytes.length)).toString("hex") }
          : { text: validText.slice(0, maximum), truncated: validText.length > maximum }),
        untrusted: true
      });
    } else if (manifest.parser === "docx") {
      const read = await readDocx(sourcePath, {
        sessionId: context.sessionId,
        fileId: metadata.fileId,
        sourceSha256: metadata.sourceSha256
      });
      const selectedPart = read.parts.find((candidate) => candidate.part_ref === selected.part_ref);
      data = jsonRecord({ text: selectedPart?.text ?? "", locator: selected.locator, untrusted: true });
    } else if (manifest.parser === "pptx") {
      const read = await readPptx(sourcePath, {
        sessionId: context.sessionId,
        fileId: metadata.fileId,
        sourceSha256: metadata.sourceSha256
      });
      const selectedPart = read.parts.find((candidate) => candidate.part_ref === selected.part_ref);
      data = jsonRecord({ text: selectedPart?.text ?? "", locator: selected.locator, untrusted: true });
    } else if (manifest.parser === "xlsx") {
      const sheet = selected.locator.sheet;
      if (typeof sheet !== "string") throw new OpenFileError("FILE_PART_NOT_FOUND", "The worksheet locator is invalid.");
      const range = arguments_.range;
      const read = await readXlsx(
        sourcePath,
        { sessionId: context.sessionId, fileId: metadata.fileId, sourceSha256: metadata.sourceSha256 },
        range === undefined ? {} : { range: range.includes("!") ? range : `${sheet}!${range}` }
      );
      const selectedSheet = read.sheets.find((candidate) => candidate.name === sheet);
      data = jsonRecord({ sheet: selectedSheet ?? null, untrusted: true });
    } else {
      data = jsonRecord({
        detected_type: metadata.detectedType,
        size: metadata.size,
        message: "No native text projection is available for this part."
      });
    }

    return Object.freeze({
      ok: true,
      file_ref: metadata.fileRef,
      part_ref: selected.part_ref,
      source_sha256: metadata.sourceSha256,
      parser: selected.parser,
      locator: selected.locator,
      cursor,
      data
    });
  }

  async render(context: ToolOperationContext, arguments_: RenderArguments): Promise<Result> {
    const reference = parsePartRef(arguments_.part_ref);
    assertCurrentSession(context.sessionId, reference.sessionId);
    const repository = await WorkspaceRepository.open(context.workspace, context.sessionId);
    const metadata = await repository.readMetadata(reference.fileId);
    const manifest = await this.inspectManifest(repository, metadata);
    const selected = manifestParts(manifest).find((candidate) => candidate.part_ref === arguments_.part_ref);
    if (selected === undefined) throw new OpenFileError("FILE_PART_NOT_FOUND", "The selected part does not exist.");
    if (selected.locator.kind !== "page" || typeof selected.locator.page !== "number") {
      throw new OpenFileError("FILE_RENDER_FAILED", "The selected part is not renderable by the installed renderer.");
    }
    const artifactId = randomUUID();
    const artifactName = `${artifactId}.png`;
    const rendered = await renderPdfPage({
      sourcePath: repository.sourcePath(metadata.fileId),
      outputPath: repository.artifactPath(metadata.fileId, "renders", artifactName),
      page: selected.locator.page,
      scale: arguments_.scale ?? 1.5,
      sourceSha256: metadata.sourceSha256,
      limits: this.limits
    });
    const renderedPart = part(
      metadata,
      "render",
      artifactId,
      "render",
      {
        kind: "render",
        source_part_ref: selected.part_ref,
        page: selected.locator.page,
        artifact: artifactName
      },
      "pdfjs-render",
      artifactName
    );
    await repository.writeManifest(metadata.fileId, {
      ...manifest,
      parts: [...manifestParts(manifest), renderedPart]
    });
    return Object.freeze({
      ok: true,
      file_ref: metadata.fileRef,
      part_ref: renderedPart.part_ref,
      source_sha256: metadata.sourceSha256,
      parser: "pdfjs-render",
      locator: renderedPart.locator,
      cursor: null,
      data: jsonRecord(rendered)
    });
  }

  async ocr(context: ToolOperationContext, arguments_: OcrArguments): Promise<Result> {
    const reference = parsePartRef(arguments_.part_ref);
    assertCurrentSession(context.sessionId, reference.sessionId);
    const repository = await WorkspaceRepository.open(context.workspace, context.sessionId);
    const metadata = await repository.readMetadata(reference.fileId);
    const manifest = await this.inspectManifest(repository, metadata);
    const selected = manifestParts(manifest).find((candidate) => candidate.part_ref === arguments_.part_ref);
    if (selected === undefined) throw new OpenFileError("FILE_PART_NOT_FOUND", "The selected part does not exist.");
    let imagePath: string;
    if (selected.locator.kind === "source" && metadata.detectedType.startsWith("image/")) {
      imagePath = repository.sourcePath(metadata.fileId);
    } else if (selected.locator.kind === "render" && typeof selected.artifact === "string") {
      imagePath = repository.artifactPath(metadata.fileId, "renders", selected.artifact);
    } else {
      throw new OpenFileError("FILE_OCR_FAILED", "The selected part is not a local image artifact.");
    }
    const artifactId = randomUUID();
    const artifactName = `${artifactId}.json`;
    const recognized = await this.ocrService.run({
      imagePath,
      outputPath: repository.artifactPath(metadata.fileId, "parts", artifactName),
      partRef: selected.part_ref,
      sourceSha256: metadata.sourceSha256,
      languages: arguments_.languages,
      locator: selected.locator,
      limits: this.limits,
      signal: context.signal
    });
    const ocrPart = part(
      metadata,
      "ocr",
      artifactId,
      "ocr",
      { kind: "ocr", source_part_ref: selected.part_ref, artifact: artifactName },
      "tesseract-local",
      artifactName
    );
    await repository.writeManifest(metadata.fileId, {
      ...manifest,
      parts: [...manifestParts(manifest), ocrPart]
    });
    return Object.freeze({
      ok: true,
      file_ref: metadata.fileRef,
      part_ref: selected.part_ref,
      source_sha256: metadata.sourceSha256,
      parser: "tesseract-local",
      locator: selected.locator,
      cursor: null,
      data: jsonRecord({
        text: recognized.text,
        confidence: recognized.confidence,
        languages: recognized.languages,
        artifact_part_ref: ocrPart.part_ref,
        untrusted: true
      })
    });
  }

  private async attachment(
    context: ToolOperationContext,
    fileRef: string
  ): Promise<{ repository: WorkspaceRepository; metadata: StoredFileMetadata }> {
    const reference = parseAttachmentRef(fileRef);
    assertCurrentSession(context.sessionId, reference.sessionId);
    const repository = await WorkspaceRepository.open(context.workspace, context.sessionId);
    return { repository, metadata: await repository.resolveAttachment(fileRef) };
  }

  private async inspectManifest(
    repository: WorkspaceRepository,
    metadata: StoredFileMetadata
  ): Promise<StoredManifest> {
    const existing = await repository.readManifest(metadata.fileId);
    if (existing.inspected === true) return existing;
    const sourcePath = repository.sourcePath(metadata.fileId);
    const parts: ManifestPart[] = [];
    let summary: Record<string, JsonValue> = {};
    if (existing.parser === "pdfjs") {
      const loaded = await loadPdf(sourcePath, this.limits);
      try {
        summary = { page_count: loaded.document.numPages };
        for (let page = 1; page <= loaded.document.numPages; page += 1) {
          parts.push(part(metadata, "pdf-page", `page:${page}`, "pdf-page", { kind: "page", page }, "pdfjs"));
        }
      } finally {
        await loaded.close().catch(() => undefined);
      }
    } else if (existing.parser === "safe-zip") {
      const archive = await SafeZip.open(sourcePath, this.limits);
      summary = { entry_count: archive.entries.length };
      for (const entry of archive.entries) {
        if (entry.directory) continue;
        parts.push(
          part(
            metadata,
            "archive-entry",
            `entry:${parts.length + 1}`,
            "archive-entry",
            { kind: "archive-entry", entry: entry.name },
            "safe-zip"
          )
        );
      }
    } else if (existing.parser === "docx" || existing.parser === "pptx" || existing.parser === "xlsx") {
      const archive = await SafeZip.open(sourcePath, this.limits);
      if (existing.parser === "docx") {
        parts.push(part(metadata, "docx-section", "document", "docx-section", { kind: "document" }, "docx"));
        if (archive.entries.some((entry) => entry.name === "word/footnotes.xml")) {
          parts.push(part(metadata, "docx-section", "footnotes", "docx-section", { kind: "footnotes" }, "docx"));
        }
      } else if (existing.parser === "pptx") {
        const slides = archive.entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry.name));
        for (const [index, entry] of slides.entries()) {
          parts.push(part(metadata, "pptx-slide", `slide:${index + 1}`, "pptx-slide", { kind: "slide", index: index + 1, entry: entry.name }, "pptx"));
        }
        summary = { slide_count: slides.length };
      } else {
        const workbook = (await archive.readEntry("xl/workbook.xml")).toString("utf8");
        for (const tag of startTags(workbook, "sheet")) {
          const name = attribute(tag, "name");
          if (name !== undefined) parts.push(part(metadata, "xlsx-sheet", `sheet:${name}`, "xlsx-sheet", { kind: "sheet", sheet: name }, "xlsx"));
        }
        summary = { sheet_count: parts.length };
      }
      for (const entry of archive.entries.filter((candidate) => /\/(?:media)\//u.test(candidate.name) && !candidate.directory)) {
        parts.push(part(metadata, `${existing.parser}-media`, `media:${parts.length + 1}`, "media", { kind: "media", entry: entry.name }, existing.parser));
      }
    } else {
      const family = metadata.detectedType.startsWith("image/") ? "image" : existing.parser === "text" ? "text" : "binary";
      parts.push(part(metadata, family, "source", family, { kind: "source" }, existing.parser));
    }
    const manifest: StoredManifest = {
      ...existing,
      inspected: true,
      summary,
      warnings: [],
      parts
    };
    await repository.writeManifest(metadata.fileId, manifest);
    return manifest;
  }
}
