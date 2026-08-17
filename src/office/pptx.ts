import { posix } from "node:path";

import { SafeZip } from "../archive/safe-zip.js";
import { DEFAULT_LIMITS } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import type { ParsedPart, ParseContext } from "../files/types.js";
import { createPartRef } from "../references.js";
import { readRelationships, resolveRelationshipTarget } from "./relationships.js";
import { attribute, startTags, textValues } from "./xml.js";

export interface PptxSlide {
  readonly index: number;
  readonly source: string;
  readonly text: string;
}

export interface PptxResult {
  readonly parser: "pptx";
  readonly text: string;
  readonly slides: readonly PptxSlide[];
  readonly parts: readonly ParsedPart[];
}

export async function readPptx(path: string, context: ParseContext): Promise<PptxResult> {
  const archive = await SafeZip.open(path, DEFAULT_LIMITS);
  const names = new Set(archive.entries.map((entry) => entry.name));
  if (!names.has("ppt/presentation.xml") || !names.has("ppt/_rels/presentation.xml.rels")) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The PPTX presentation index is missing.");
  }
  const presentation = (await archive.readEntry("ppt/presentation.xml")).toString("utf8");
  const relationships = readRelationships(
    (await archive.readEntry("ppt/_rels/presentation.xml.rels")).toString("utf8")
  );
  const orderedTargets: string[] = [];
  for (const tag of startTags(presentation, "sldId")) {
    const id = attribute(tag, "r:id");
    const relationship = id === undefined ? undefined : relationships.get(id);
    if (relationship === undefined || relationship.external) {
      throw new OpenFileError("FILE_PARSE_FAILED", "A PPTX slide relationship is invalid.");
    }
    orderedTargets.push(resolveRelationshipTarget("ppt", relationship));
  }

  const slides: PptxSlide[] = [];
  const parts: ParsedPart[] = [];
  const textSections: string[] = [];
  for (const [zeroIndex, target] of orderedTargets.entries()) {
    if (!names.has(target)) throw new OpenFileError("FILE_PARSE_FAILED", "A PPTX slide is missing.");
    const index = zeroIndex + 1;
    const values = textValues((await archive.readEntry(target)).toString("utf8"));
    const text = values.join("\n").trim();
    slides.push(Object.freeze({ index, source: target, text }));
    textSections.push(`## Slide ${index}\n\n${text}`);
    parts.push(
      Object.freeze({
        part_ref: createPartRef(context.sessionId, context.fileId, "pptx-slide", `slide:${index}`),
        kind: "pptx-slide",
        locator: Object.freeze({ kind: "slide", index, entry: target }),
        parser: "pptx",
        source_sha256: context.sourceSha256,
        text
      })
    );

    const sourceNumber = posix.basename(target).match(/^slide(\d+)\.xml$/u)?.[1];
    const notesName = sourceNumber === undefined ? undefined : `ppt/notesSlides/notesSlide${sourceNumber}.xml`;
    if (notesName !== undefined && names.has(notesName)) {
      const notes = textValues((await archive.readEntry(notesName)).toString("utf8")).join("\n").trim();
      if (notes.length > 0) {
        textSections.push(`Notes for slide ${index}: ${notes}`);
        parts.push(
          Object.freeze({
            part_ref: createPartRef(context.sessionId, context.fileId, "pptx-slide", `notes:${index}`),
            kind: "notes",
            locator: Object.freeze({ kind: "notes", slide: index, entry: notesName }),
            parser: "pptx",
            source_sha256: context.sourceSha256,
            text: notes
          })
        );
      }
    }
  }

  for (const entry of archive.entries.filter((candidate) => /^ppt\/charts\/chart\d+\.xml$/u.test(candidate.name))) {
    const values = textValues((await archive.readEntry(entry.name)).toString("utf8"), "v");
    const text = values.join(" | ");
    textSections.push(`Chart: ${text}`);
    parts.push(
      Object.freeze({
        part_ref: createPartRef(context.sessionId, context.fileId, "pptx-slide", `chart:${posix.basename(entry.name)}`),
        kind: "chart",
        locator: Object.freeze({ kind: "chart", entry: entry.name }),
        parser: "pptx",
        source_sha256: context.sourceSha256,
        text
      })
    );
  }
  for (const entry of archive.entries.filter((candidate) => candidate.name.startsWith("ppt/media/") && !candidate.directory)) {
    parts.push(
      Object.freeze({
        part_ref: createPartRef(context.sessionId, context.fileId, "pptx-slide", `media:${posix.basename(entry.name)}`),
        kind: "media",
        locator: Object.freeze({ kind: "media", entry: entry.name }),
        parser: "pptx",
        source_sha256: context.sourceSha256
      })
    );
  }
  return Object.freeze({
    parser: "pptx",
    text: textSections.join("\n\n"),
    slides: Object.freeze(slides),
    parts: Object.freeze(parts)
  });
}
