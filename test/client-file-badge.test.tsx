// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FileBadge, fileBadgeSpec } from "../src/client/file-badge.js";

describe("file format badge", () => {
  it.each([
    ["paper.pdf", undefined, "pdf", "PDF"],
    ["proposal.docx", undefined, "word", "DOCX"],
    ["slides.pptx", undefined, "powerpoint", "PPTX"],
    ["budget.xlsx", undefined, "excel", "XLSX"],
    ["bundle.zip", undefined, "archive", "ZIP"],
    ["rows.csv", undefined, "tabular", "CSV"],
    ["notes.txt", undefined, "text", "TXT"],
    ["payload.bin", undefined, "generic", "FILE"],
  ])("classifies %s as a %s badge", (name, detectedType, family, label) => {
    expect(fileBadgeSpec(name, detectedType)).toEqual({ family, label });
  });

  it("prefers the detected media type over a misleading extension", () => {
    expect(fileBadgeSpec("misleading.pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toEqual({ family: "word", label: "DOCX" });
  });

  it.each([
    ["program.py", "PY"],
    ["worker.js", "JS"],
    ["module.mjs", "MJS"],
    ["legacy.cjs", "CJS"],
    ["types.ts", "TS"],
    ["component.tsx", "TSX"],
    ["view.jsx", "JSX"],
    ["page.html", "HTML"],
    ["theme.css", "CSS"],
    ["theme.scss", "SCSS"],
    ["screen.vue", "VUE"],
    ["Main.java", "JAVA"],
    ["App.kt", "KT"],
    ["Scene.swift", "SWIFT"],
    ["server.go", "GO"],
    ["engine.rs", "RS"],
    ["native.c", "C"],
    ["native.cpp", "CPP"],
    ["Program.cs", "C#"],
    ["index.php", "PHP"],
    ["task.rb", "RB"],
    ["plugin.lua", "LUA"],
    ["main.dart", "DART"],
    ["setup.sh", "SH"],
    ["setup.zsh", "ZSH"],
    ["deploy.ps1", "PS1"],
    ["query.sql", "SQL"],
    ["schema.graphql", "GQL"],
    ["event.proto", "PROTO"],
    ["data.json", "JSON"],
    ["events.jsonl", "JSONL"],
    ["feed.xml", "XML"],
    ["config.yaml", "YAML"],
    ["config.toml", "TOML"],
    ["settings.ini", "INI"],
    ["local.env", "ENV"],
    ["readme.md", "MD"],
    ["trace.log", "LOG"],
    ["table.tsv", "TSV"],
    ["letter.doc", "DOC"],
    ["slides.ppt", "PPT"],
    ["ledger.xls", "XLS"],
    ["letter.odt", "ODT"],
    ["ledger.ods", "ODS"],
    ["slides.odp", "ODP"],
    ["formatted.rtf", "RTF"],
    ["book.epub", "EPUB"],
    ["bundle.rar", "RAR"],
    ["bundle.7z", "7Z"],
    ["bundle.tar", "TAR"],
    ["bundle.gz", "GZ"],
  ])("uses an explicit badge for %s", (name, label) => {
    expect(fileBadgeSpec(name)).toMatchObject({ label });
  });

  it("does not let a generic text MIME type erase a known code format", () => {
    expect(fileBadgeSpec("program.py", "text/plain")).toEqual({ family: "code", label: "PY" });
  });

  it("renders the format name inside the source document outline without a backing tile", () => {
    render(<FileBadge displayName="report.pdf" />);
    const badge = screen.getByLabelText("PDF file");
    expect(badge.getAttribute("data-family")).toBe("pdf");
    const glyph = badge.querySelector('svg[viewBox="0 0 24 24"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.querySelector('path[d="M14 2v5a1 1 0 0 0 1 1h5"]')).not.toBeNull();
    expect(glyph?.querySelectorAll("path")).toHaveLength(2);
    expect(glyph?.querySelector("text")?.textContent).toBe("PDF");
    expect(badge.querySelector(".dof-file-format")).toBeNull();
  });

  it("renders the source three-line glyph for an unregistered extension", () => {
    render(<FileBadge displayName="artifact.unusual" detectedType="text/plain" />);
    const badge = screen.getByLabelText("File");
    const glyph = badge.querySelector("svg");
    expect(glyph?.querySelector("text")).toBeNull();
    expect(glyph?.querySelector('path[d="M10 9H8"]')).not.toBeNull();
    expect(glyph?.querySelector('path[d="M16 13H8"]')).not.toBeNull();
    expect(glyph?.querySelector('path[d="M16 17H8"]')).not.toBeNull();
  });
});
