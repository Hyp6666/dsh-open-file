import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDocx } from "../src/office/docx.js";
import { parseOfficeXml } from "../src/office/xml.js";
import { readPptx } from "../src/office/pptx.js";
import { readXlsx } from "../src/office/xlsx.js";
import { writeZip } from "./helpers/zip.js";

let root: string;
const context = {
  sessionId: "session-a",
  fileId: "018f3f08-a9d1-7d01-9128-112233445566",
  sourceSha256: "a".repeat(64)
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-open-file-office-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("secure Office XML", () => {
  it.each([
    '<!DOCTYPE x [<!ENTITY p SYSTEM "file:///etc/passwd">]><x>&p;</x>',
    '<!ENTITY x SYSTEM "https://example.test/external"><x/>'
  ])("rejects DTD/entity input without resolving it", (xml) => {
    expect(() => parseOfficeXml(xml)).toThrow();
    try {
      parseOfficeXml(xml);
    } catch (error) {
      expect(error).toMatchObject({ code: "FILE_PARSE_FAILED" });
    }
  });
});

describe("DOCX reader", () => {
  it("extracts headings, paragraphs, links, tables, footnotes, and media parts", async () => {
    const path = join(root, "report.docx");
    await writeZip(path, [
      { name: "[Content_Types].xml", data: "<Types/>" },
      {
        name: "word/document.xml",
        data: `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
          <w:p><w:r><w:t>See </w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:t>details</w:t></w:r></w:hyperlink></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>`
      },
      {
        name: "word/_rels/document.xml.rels",
        data: '<Relationships xmlns="r"><Relationship Id="rId5" Target="https://example.test/details" TargetMode="External"/></Relationships>'
      },
      {
        name: "word/footnotes.xml",
        data: '<w:footnotes xmlns:w="w"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote one</w:t></w:r></w:p></w:footnote></w:footnotes>'
      },
      { name: "word/media/image1.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
    ]);

    const result = await readDocx(path, context);
    expect(result.text).toContain("# Quarterly Report");
    expect(result.text).toContain("See [details](https://example.test/details)");
    expect(result.text).toContain("| Name | Value |");
    expect(result.text).toContain("| A | 42 |");
    expect(result.text).toContain("Footnote one");
    const kinds = new Set(result.parts.map((part) => part.locator.kind));
    expect(kinds.has("document")).toBe(true);
    expect(kinds.has("footnotes")).toBe(true);
    expect(kinds.has("media")).toBe(true);
    for (const part of result.parts) {
      expect(part.part_ref).toContain("dsh-open-file://part/v1/");
      expect(part.source_sha256).toBe(context.sourceSha256);
      expect(part.parser).toBe("docx");
    }
  });
});

describe("PPTX reader", () => {
  it("honors presentation order and extracts slide text, notes, charts, and media", async () => {
    const path = join(root, "slides.pptx");
    await writeZip(path, [
      { name: "[Content_Types].xml", data: "<Types/>" },
      {
        name: "ppt/presentation.xml",
        data: '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="2" r:id="rId2"/><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>'
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>'
      },
      { name: "ppt/slides/slide1.xml", data: '<p:sld xmlns:p="p" xmlns:a="a"><a:t>First slide</a:t></p:sld>' },
      { name: "ppt/slides/slide2.xml", data: '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Second slide</a:t><a:t>Table cell</a:t></p:sld>' },
      { name: "ppt/notesSlides/notesSlide2.xml", data: '<p:notes xmlns:p="p" xmlns:a="a"><a:t>Speaker note</a:t></p:notes>' },
      { name: "ppt/charts/chart1.xml", data: '<c:chart xmlns:c="c"><c:v>Revenue</c:v><c:v>100</c:v></c:chart>' },
      { name: "ppt/media/image1.jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) }
    ]);

    const result = await readPptx(path, context);
    expect(result.slides.map((slide) => slide.text)).toEqual([
      expect.stringContaining("Second slide"),
      expect.stringContaining("First slide")
    ]);
    expect(result.text).toContain("Speaker note");
    expect(result.text).toContain("Revenue | 100");
    expect(result.parts.map((part) => part.locator.kind)).toEqual(
      expect.arrayContaining(["slide", "notes", "chart", "media"])
    );
  });
});

describe("XLSX reader", () => {
  it("extracts sheet order, shared strings, formulas, ranges, and merged cells", async () => {
    const path = join(root, "book.xlsx");
    await writeZip(path, [
      { name: "[Content_Types].xml", data: "<Types/>" },
      {
        name: "xl/workbook.xml",
        data: '<workbook xmlns:r="r"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>'
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
      },
      {
        name: "xl/sharedStrings.xml",
        data: '<sst><si><t>项目</t></si><si><t>苹果</t></si></sst>'
      },
      {
        name: "xl/styles.xml",
        data: '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<worksheet><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>10</v></c><c r="C1" s="1"><v>45292</v></c></row>
          <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(B1,5)</f><v>15</v></c></row>
        </sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>`
      }
    ]);

    const result = await readXlsx(path, context, { range: "数据!A1:C2" });
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]).toMatchObject({ name: "数据", range: "A1:C2" });
    expect(result.text).toContain("| 项目 | 10 |");
    expect(result.text).toContain("| 苹果 | =SUM(B1,5) → 15 |");
    expect(result.text).toContain("2024-01-01");
    expect(result.sheets[0]?.mergedCells).toEqual(["A3:B3"]);
    expect(result.parts[0]).toMatchObject({
      locator: { kind: "sheet", sheet: "数据", range: "A1:C2" },
      parser: "xlsx",
      source_sha256: context.sourceSha256
    });
  });
});
