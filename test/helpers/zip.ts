import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";

import { ZipFile } from "yazl";

export interface ZipFixtureEntry {
  readonly name: string;
  readonly data: string | Buffer;
  readonly compress?: boolean;
  readonly mode?: number;
}

export async function writeZip(path: string, entries: readonly ZipFixtureEntry[]): Promise<void> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
  for (const entry of entries) {
    archive.addBuffer(Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data), entry.name, {
      compress: entry.compress ?? true,
      ...(entry.mode === undefined ? {} : { mode: entry.mode })
    });
  }
  archive.end();
  await once(archive.outputStream, "end");
  await writeFile(path, Buffer.concat(chunks));
}

export async function writeZipWithRawName(path: string, rawName: string): Promise<void> {
  const raw = Buffer.from(rawName, "utf8");
  const placeholder = "x".repeat(raw.length);
  await writeZip(path, [{ name: placeholder, data: "x" }]);
  const bytes = await readFile(path);
  const marker = Buffer.from(placeholder, "utf8");
  let offset = 0;
  let replacements = 0;
  while ((offset = bytes.indexOf(marker, offset)) !== -1) {
    raw.copy(bytes, offset);
    offset += marker.length;
    replacements += 1;
  }
  if (replacements < 2) throw new Error("ZIP fixture name markers were not found");
  await writeFile(path, bytes);
}
