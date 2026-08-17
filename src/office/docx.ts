import { DEFAULT_LIMITS } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import { createPartRef } from "../references.js";
import { SafeZip } from "../archive/safe-zip.js";
import type { ParsedPart, ParseContext } from "../files/types.js";
import { readRelationships } from "./relationships.js";
import { attribute, elements, escapeMarkdown, startTags, textValues } from "./xml.js";

export interface DocxResult {
  readonly parser: "docx";
  readonly text: string;
  readonly parts: readonly ParsedPart[];
}

function paragraphText(fragment: string, links: ReadonlyMap<string, string>): string {
  let position = 0;
  let output = "";
  const hyperlink = /<(?:[A-Za-z_][\w.-]*:)?hyperlink\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?hyperlink\s*>/giu;
  for (const match of fragment.matchAll(hyperlink)) {
    const index = match.index;
    output += textValues(fragment.slice(position, index)).join("");
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const id = attribute(tag, "r:id");
    const label = textValues(match[2] ?? "").join("");
    const target = id === undefined ? undefined : links.get(id);
    output += target === undefined ? label : `[${label}](${target})`;
    position = index + match[0].length;
  }
  output += textValues(fragment.slice(position)).join("");
  return output.trim();
}

function tableMarkdown(fragment: string): string {
  const rows = elements(fragment, "tr").map((row) =>
    elements(row, "tc").map((cell) => escapeMarkdown(textValues(cell).join(" ").trim()))
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  const lines = [
    `| ${normalized[0]?.join(" | ") ?? ""} |`,
    `| ${Array<string>(width).fill("---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`)
  ];
  return lines.join("\n");
}

export async function readDocx(path: string, context: ParseContext): Promise<DocxResult> {
  const archive = await SafeZip.open(path, DEFAULT_LIMITS);
  const names = new Set(archive.entries.map((entry) => entry.name));
  if (!names.has("word/document.xml")) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The DOCX document part is missing.");
  }
  const documentXml = (await archive.readEntry("word/document.xml")).toString("utf8");
  const links = new Map<string, string>();
  if (names.has("word/_rels/document.xml.rels")) {
    const relationships = readRelationships(
      (await archive.readEntry("word/_rels/document.xml.rels")).toString("utf8")
    );
    for (const relationship of relationships.values()) {
      if (relationship.external) links.set(relationship.id, relationship.target);
    }
  }

  const tables = elements(documentXml, "tbl");
  let paragraphsOnly = documentXml;
  for (const table of tables) paragraphsOnly = paragraphsOnly.replace(table, "");
  const paragraphs = elements(paragraphsOnly, "p")
    .map((paragraph) => {
      const text = paragraphText(paragraph, links);
      if (text.length === 0) return "";
      const styleTag = startTags(paragraph, "pStyle")[0];
      const style = styleTag === undefined ? undefined : attribute(styleTag, "w:val");
      const heading = style?.match(/^Heading([1-6])$/iu)?.[1];
      if (heading !== undefined) return `${"#".repeat(Number(heading))} ${text}`;
      if (paragraph.includes(":numPr")) return `- ${text}`;
      return text;
    })
    .filter((value) => value.length > 0);
  const sections = [...paragraphs, ...tables.map(tableMarkdown).filter((value) => value.length > 0)];
  const parts: ParsedPart[] = [
    Object.freeze({
      part_ref: createPartRef(context.sessionId, context.fileId, "docx-section", "document"),
      kind: "docx-section",
      locator: Object.freeze({ kind: "document" }),
      parser: "docx",
      source_sha256: context.sourceSha256,
      text: sections.join("\n\n")
    })
  ];

  if (names.has("word/footnotes.xml")) {
    const xml = (await archive.readEntry("word/footnotes.xml")).toString("utf8");
    const footnotes = elements(xml, "footnote")
      .map((footnote) => textValues(footnote).join(" ").trim())
      .filter((value) => value.length > 0);
    if (footnotes.length > 0) {
      const text = `## Footnotes\n\n${footnotes.map((value, index) => `${index + 1}. ${value}`).join("\n")}`;
      sections.push(text);
      parts.push(
        Object.freeze({
          part_ref: createPartRef(context.sessionId, context.fileId, "docx-section", "footnotes"),
          kind: "docx-section",
          locator: Object.freeze({ kind: "footnotes" }),
          parser: "docx",
          source_sha256: context.sourceSha256,
          text
        })
      );
    }
  }
  for (const entry of archive.entries.filter((candidate) => candidate.name.startsWith("word/media/") && !candidate.directory)) {
    const id = entry.name.slice("word/media/".length);
    parts.push(
      Object.freeze({
        part_ref: createPartRef(context.sessionId, context.fileId, "docx-section", `media:${id}`),
        kind: "media",
        locator: Object.freeze({ kind: "media", entry: entry.name }),
        parser: "docx",
        source_sha256: context.sourceSha256
      })
    );
  }
  return Object.freeze({ parser: "docx", text: sections.join("\n\n"), parts: Object.freeze(parts) });
}
