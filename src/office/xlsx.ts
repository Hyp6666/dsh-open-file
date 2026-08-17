import { SafeZip } from "../archive/safe-zip.js";
import { DEFAULT_LIMITS } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import type { ParsedPart, ParseContext } from "../files/types.js";
import { createPartRef } from "../references.js";
import { readRelationships, resolveRelationshipTarget } from "./relationships.js";
import { attribute, elements, escapeMarkdown, startTags, textValues } from "./xml.js";

interface Cell {
  readonly reference: string;
  readonly row: number;
  readonly column: number;
  readonly display: string;
}

export interface XlsxSheet {
  readonly name: string;
  readonly range: string;
  readonly mergedCells: readonly string[];
  readonly text: string;
}

export interface XlsxResult {
  readonly parser: "xlsx";
  readonly text: string;
  readonly sheets: readonly XlsxSheet[];
  readonly parts: readonly ParsedPart[];
}

function columnNumber(letters: string): number {
  let value = 0;
  for (const character of letters) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function columnLetters(value: number): string {
  let current = value;
  let output = "";
  while (current > 0) {
    current -= 1;
    output = String.fromCharCode(65 + (current % 26)) + output;
    current = Math.floor(current / 26);
  }
  return output;
}

function coordinate(reference: string): { row: number; column: number } {
  const match = reference.toUpperCase().match(/^([A-Z]+)([1-9]\d*)$/u);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new OpenFileError("FILE_PARSE_FAILED", "An XLSX cell reference is invalid.");
  }
  return { row: Number(match[2]), column: columnNumber(match[1]) };
}

function parseRange(value: string): { startRow: number; endRow: number; startColumn: number; endColumn: number; canonical: string } {
  const match = value.match(/^([A-Z]+[1-9]\d*):([A-Z]+[1-9]\d*)$/iu);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", "The XLSX range is invalid.");
  }
  const start = coordinate(match[1]);
  const end = coordinate(match[2]);
  if (start.row > end.row || start.column > end.column) {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", "The XLSX range is reversed.");
  }
  return {
    startRow: start.row,
    endRow: end.row,
    startColumn: start.column,
    endColumn: end.column,
    canonical: `${columnLetters(start.column)}${start.row}:${columnLetters(end.column)}${end.row}`
  };
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyleIndexes(styles: string): Set<number> {
  const customDates = new Set<number>();
  for (const tag of startTags(styles, "numFmt")) {
    const id = Number(attribute(tag, "numFmtId"));
    const format = (attribute(tag, "formatCode") ?? "")
      .replace(/"[^"]*"/gu, "")
      .replace(/\[[^\]]*\]/gu, "");
    if (Number.isSafeInteger(id) && /[ymdhis]/iu.test(format)) customDates.add(id);
  }
  const cellXfs = elements(styles, "cellXfs")[0] ?? "";
  const indexes = new Set<number>();
  for (const [index, tag] of startTags(cellXfs, "xf").entries()) {
    const id = Number(attribute(tag, "numFmtId") ?? "0");
    if (BUILTIN_DATE_FORMATS.has(id) || customDates.has(id)) indexes.add(index);
  }
  return indexes;
}

function excelDate(serial: number, date1904: boolean): string {
  const days = Math.floor(serial);
  const fraction = serial - days;
  const adjustedDays = date1904 ? days : days >= 60 ? days - 1 : days;
  const base = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
  const date = new Date(base + adjustedDays * 86_400_000 + Math.round(fraction * 86_400_000));
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return fraction === 0 ? iso.slice(0, 10) : iso.replace(/\.000Z$/u, "Z");
}

function cellValue(
  fragment: string,
  type: string | undefined,
  sharedStrings: readonly string[],
  isDate: boolean,
  date1904: boolean
): string {
  const formula = textValues(fragment, "f")[0];
  const raw = textValues(fragment, "v")[0] ?? "";
  let value = raw;
  if (type === "s") {
    const index = Number(raw);
    value = Number.isSafeInteger(index) && sharedStrings[index] !== undefined ? sharedStrings[index] : "";
  } else if (type === "inlineStr") {
    value = textValues(fragment, "t").join("");
  } else if (type === "b") {
    value = raw === "1" ? "TRUE" : "FALSE";
  } else if (isDate && raw.trim().length > 0) {
    const serial = Number(raw);
    if (Number.isFinite(serial)) value = excelDate(serial, date1904);
  }
  return formula === undefined ? value : `=${formula} → ${value}`;
}

function renderRange(cells: readonly Cell[], range: ReturnType<typeof parseRange>): string {
  const byCoordinate = new Map(cells.map((cell) => [`${cell.row}:${cell.column}`, cell.display]));
  const rows: string[][] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const values: string[] = [];
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      values.push(escapeMarkdown(byCoordinate.get(`${row}:${column}`) ?? ""));
    }
    rows.push(values);
  }
  if (rows.length === 0) return "";
  return [
    `| ${rows[0]?.join(" | ") ?? ""} |`,
    `| ${Array<string>(range.endColumn - range.startColumn + 1).fill("---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

export async function readXlsx(
  path: string,
  context: ParseContext,
  options: { readonly range?: string } = {}
): Promise<XlsxResult> {
  const archive = await SafeZip.open(path, DEFAULT_LIMITS);
  const names = new Set(archive.entries.map((entry) => entry.name));
  if (!names.has("xl/workbook.xml") || !names.has("xl/_rels/workbook.xml.rels")) {
    throw new OpenFileError("FILE_PARSE_FAILED", "The XLSX workbook index is missing.");
  }
  const workbook = (await archive.readEntry("xl/workbook.xml")).toString("utf8");
  const relationships = readRelationships(
    (await archive.readEntry("xl/_rels/workbook.xml.rels")).toString("utf8")
  );
  const sharedStrings = names.has("xl/sharedStrings.xml")
    ? elements((await archive.readEntry("xl/sharedStrings.xml")).toString("utf8"), "si").map((item) =>
        textValues(item).join("")
      )
    : [];
  const styles = names.has("xl/styles.xml")
    ? dateStyleIndexes((await archive.readEntry("xl/styles.xml")).toString("utf8"))
    : new Set<number>();
  const workbookProperties = startTags(workbook, "workbookPr")[0];
  const date1904 = workbookProperties !== undefined && attribute(workbookProperties, "date1904") === "1";
  const requested = options.range?.match(/^(.+)!([A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*)$/iu);
  if (options.range !== undefined && requested === null) {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", "The XLSX locator must be Sheet!A1:B2.");
  }
  const requestedSheet = requested?.[1];
  const requestedRange = requested?.[2];
  const sheets: XlsxSheet[] = [];
  const parts: ParsedPart[] = [];
  for (const tag of startTags(workbook, "sheet")) {
    const name = attribute(tag, "name");
    const id = attribute(tag, "r:id");
    if (name === undefined || id === undefined) continue;
    if (requestedSheet !== undefined && requestedSheet !== name) continue;
    const relationship = relationships.get(id);
    if (relationship === undefined || relationship.external) {
      throw new OpenFileError("FILE_PARSE_FAILED", "An XLSX sheet relationship is invalid.");
    }
    const target = resolveRelationshipTarget("xl", relationship);
    if (!names.has(target)) throw new OpenFileError("FILE_PARSE_FAILED", "An XLSX worksheet is missing.");
    const worksheet = (await archive.readEntry(target)).toString("utf8");
    const cells: Cell[] = [];
    for (const fragment of elements(worksheet, "c")) {
      const startTag = fragment.slice(0, fragment.indexOf(">") + 1);
      const reference = attribute(startTag, "r");
      if (reference === undefined) continue;
      const point = coordinate(reference);
      cells.push(
        Object.freeze({
          reference,
          ...point,
          display: cellValue(
            fragment,
            attribute(startTag, "t"),
            sharedStrings,
            styles.has(Number(attribute(startTag, "s") ?? "0")),
            date1904
          )
        })
      );
    }
    const maximumRow = Math.max(1, ...cells.map((cell) => cell.row));
    const maximumColumn = Math.max(1, ...cells.map((cell) => cell.column));
    const range = parseRange(
      requestedRange ?? `A1:${columnLetters(maximumColumn)}${maximumRow}`
    );
    const text = renderRange(cells, range);
    const mergedCells = startTags(worksheet, "mergeCell")
      .map((merge) => attribute(merge, "ref"))
      .filter((value): value is string => value !== undefined);
    const sheet: XlsxSheet = Object.freeze({
      name,
      range: range.canonical,
      mergedCells: Object.freeze(mergedCells),
      text
    });
    sheets.push(sheet);
    parts.push(
      Object.freeze({
        part_ref: createPartRef(context.sessionId, context.fileId, "xlsx-sheet", `sheet:${name}`),
        kind: "xlsx-sheet",
        locator: Object.freeze({ kind: "sheet", sheet: name, range: range.canonical }),
        parser: "xlsx",
        source_sha256: context.sourceSha256,
        text
      })
    );
  }
  if (requestedSheet !== undefined && sheets.length === 0) {
    throw new OpenFileError("FILE_PART_NOT_FOUND", "The requested worksheet does not exist.");
  }
  return Object.freeze({
    parser: "xlsx",
    text: sheets.map((sheet) => `## ${sheet.name}\n\n${sheet.text}`).join("\n\n"),
    sheets: Object.freeze(sheets),
    parts: Object.freeze(parts)
  });
}
