import { XMLParser, XMLValidator } from "fast-xml-parser";

import { OpenFileError } from "../errors.js";

const FORBIDDEN_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)\b/iu;

export function parseOfficeXml(xml: string): unknown {
  if (FORBIDDEN_DECLARATION.test(xml)) {
    throw new OpenFileError("FILE_PARSE_FAILED", "DTD and entity declarations are not allowed.");
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The Office XML part is malformed.");
  }
  try {
    return new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      allowBooleanAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false
    }).parse(xml) as unknown;
  } catch (error) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The Office XML part could not be parsed.", undefined, {
      cause: error
    });
  }
}

export function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function elements(xml: string, localName: string): string[] {
  parseOfficeXml(xml);
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    "giu"
  );
  return [...xml.matchAll(expression)].map((match) => match[0]);
}

export function startTags(xml: string, localName: string): string[] {
  parseOfficeXml(xml);
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*\\/?>`,
    "giu"
  );
  return [...xml.matchAll(expression)].map((match) => match[0]);
}

export function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = tag.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu"));
  return match?.[2] === undefined ? undefined : decodeXmlText(match[2]);
}

export function textValues(xml: string, localName = "t"): string[] {
  if (FORBIDDEN_DECLARATION.test(xml)) {
    throw new OpenFileError("FILE_PARSE_FAILED", "DTD and entity declarations are not allowed.");
  }
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*>`,
    "giu"
  );
  return [...xml.matchAll(expression)].map((match) =>
    decodeXmlText((match[1] ?? "").replace(/<[^>]+>/gu, ""))
  );
}

export function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
