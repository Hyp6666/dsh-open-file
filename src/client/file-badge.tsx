import type { ReactElement } from "react";

export type FileBadgeFamily =
  | "pdf"
  | "word"
  | "powerpoint"
  | "excel"
  | "archive"
  | "tabular"
  | "text"
  | "code"
  | "markup"
  | "config"
  | "database"
  | "generic";

export interface FileBadgeSpec {
  readonly family: FileBadgeFamily;
  readonly label: string;
}

function spec(family: FileBadgeFamily, label: string): FileBadgeSpec {
  return Object.freeze({ family, label });
}

const GENERIC_SPEC = spec("generic", "FILE");
const TEXT_SPEC = spec("text", "TXT");

const EXTENSION_SPECS: Readonly<Record<string, FileBadgeSpec>> = Object.freeze({
  pdf: spec("pdf", "PDF"),
  doc: spec("word", "DOC"),
  docx: spec("word", "DOCX"),
  odt: spec("word", "ODT"),
  rtf: spec("word", "RTF"),
  epub: spec("word", "EPUB"),
  ppt: spec("powerpoint", "PPT"),
  pptx: spec("powerpoint", "PPTX"),
  odp: spec("powerpoint", "ODP"),
  xls: spec("excel", "XLS"),
  xlsx: spec("excel", "XLSX"),
  ods: spec("excel", "ODS"),
  zip: spec("archive", "ZIP"),
  rar: spec("archive", "RAR"),
  "7z": spec("archive", "7Z"),
  tar: spec("archive", "TAR"),
  gz: spec("archive", "GZ"),
  tgz: spec("archive", "TGZ"),
  csv: spec("tabular", "CSV"),
  tsv: spec("tabular", "TSV"),
  txt: TEXT_SPEC,
  md: spec("text", "MD"),
  log: spec("text", "LOG"),
  json: spec("config", "JSON"),
  jsonl: spec("config", "JSONL"),
  yaml: spec("config", "YAML"),
  yml: spec("config", "YAML"),
  toml: spec("config", "TOML"),
  ini: spec("config", "INI"),
  env: spec("config", "ENV"),
  xml: spec("markup", "XML"),
  html: spec("markup", "HTML"),
  htm: spec("markup", "HTML"),
  css: spec("markup", "CSS"),
  scss: spec("markup", "SCSS"),
  vue: spec("markup", "VUE"),
  py: spec("code", "PY"),
  pyw: spec("code", "PY"),
  js: spec("code", "JS"),
  mjs: spec("code", "MJS"),
  cjs: spec("code", "CJS"),
  ts: spec("code", "TS"),
  tsx: spec("code", "TSX"),
  jsx: spec("code", "JSX"),
  java: spec("code", "JAVA"),
  kt: spec("code", "KT"),
  swift: spec("code", "SWIFT"),
  go: spec("code", "GO"),
  rs: spec("code", "RS"),
  c: spec("code", "C"),
  cpp: spec("code", "CPP"),
  cs: spec("code", "C#"),
  php: spec("code", "PHP"),
  rb: spec("code", "RB"),
  lua: spec("code", "LUA"),
  dart: spec("code", "DART"),
  sh: spec("code", "SH"),
  zsh: spec("code", "ZSH"),
  ps1: spec("code", "PS1"),
  sql: spec("database", "SQL"),
  graphql: spec("database", "GQL"),
  gql: spec("database", "GQL"),
  proto: spec("code", "PROTO"),
});

const BASENAME_SPECS: Readonly<Record<string, FileBadgeSpec>> = Object.freeze({
  dockerfile: spec("code", "DKR"),
  makefile: spec("code", "MAKE"),
  "cmakelists.txt": spec("code", "CMAKE"),
});

function specFromMediaType(mediaType: string): FileBadgeSpec | undefined {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLocaleLowerCase();
  if (!normalized || normalized === "application/octet-stream") return undefined;
  if (normalized === "application/pdf") return EXTENSION_SPECS.pdf;
  if (normalized === "application/msword") return EXTENSION_SPECS.doc;
  if (normalized.includes("wordprocessingml")) return EXTENSION_SPECS.docx;
  if (normalized === "application/vnd.ms-powerpoint") return EXTENSION_SPECS.ppt;
  if (normalized.includes("presentationml")) return EXTENSION_SPECS.pptx;
  if (normalized === "application/vnd.ms-excel") return EXTENSION_SPECS.xls;
  if (normalized.includes("spreadsheetml")) return EXTENSION_SPECS.xlsx;
  if (normalized === "application/zip") return EXTENSION_SPECS.zip;
  if (normalized === "application/x-7z-compressed") return EXTENSION_SPECS["7z"];
  if (normalized === "application/vnd.rar") return EXTENSION_SPECS.rar;
  if (normalized === "application/gzip") return EXTENSION_SPECS.gz;
  if (normalized === "application/x-tar") return EXTENSION_SPECS.tar;
  if (normalized === "text/csv") return EXTENSION_SPECS.csv;
  if (normalized === "text/tab-separated-values") return EXTENSION_SPECS.tsv;
  if (normalized === "application/json" || normalized.endsWith("+json")) return EXTENSION_SPECS.json;
  if (normalized === "application/xml" || normalized.endsWith("+xml")) return EXTENSION_SPECS.xml;
  if (normalized === "application/javascript" || normalized === "text/javascript") return EXTENSION_SPECS.js;
  if (normalized === "text/x-python") return EXTENSION_SPECS.py;
  if (normalized.startsWith("text/")) return TEXT_SPEC;
  return undefined;
}

function explicitSpecFromName(displayName: string): FileBadgeSpec | undefined {
  const basename = displayName.split(/[\\/]/).pop()?.toLocaleLowerCase() ?? "";
  const basenameSpec = BASENAME_SPECS[basename];
  if (basenameSpec !== undefined) return basenameSpec;
  const dot = basename.lastIndexOf(".");
  if (dot < 0 || dot === basename.length - 1) return undefined;
  return EXTENSION_SPECS[basename.slice(dot + 1)];
}

function hasExtension(displayName: string): boolean {
  const basename = displayName.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  return dot >= 0 && dot < basename.length - 1;
}

export function fileBadgeSpec(displayName: string, detectedType?: string): FileBadgeSpec {
  const explicit = explicitSpecFromName(displayName);
  const detected = detectedType === undefined ? undefined : specFromMediaType(detectedType);

  if (explicit !== undefined) {
    return detected === undefined || detected === TEXT_SPEC ? explicit : detected;
  }
  if (hasExtension(displayName)) return detected === TEXT_SPEC || detected === undefined ? GENERIC_SPEC : detected;
  return detected ?? GENERIC_SPEC;
}

export interface FileBadgeProps {
  readonly displayName: string;
  readonly detectedType?: string | undefined;
}

export function FileBadge({ displayName, detectedType }: FileBadgeProps): ReactElement {
  const badgeSpec = fileBadgeSpec(displayName, detectedType);
  const formatSize = badgeSpec.label.length > 4 ? 3.5 : badgeSpec.label.length > 3 ? 4.2 : 5.2;
  const isGeneric = badgeSpec.family === "generic";
  return (
    <span
      className="dof-file-badge"
      data-family={badgeSpec.family}
      role="img"
      aria-label={isGeneric ? "File" : `${badgeSpec.label} file`}
    >
      <svg
        className="dof-file-glyph"
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
        <path d="M14 2v5a1 1 0 0 0 1 1h5" />
        {isGeneric ? (
          <>
            <path d="M10 9H8" />
            <path d="M16 13H8" />
            <path d="M16 17H8" />
          </>
        ) : (
          <text
            className="dof-file-format-text"
            x="12"
            y="14.1"
            fill="currentColor"
            stroke="none"
            fontSize={formatSize}
            fontWeight="800"
            letterSpacing="0.15"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {badgeSpec.label}
          </text>
        )}
      </svg>
    </span>
  );
}
