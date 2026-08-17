import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "../src/contracts.js";
import { SafeZip } from "../src/archive/safe-zip.js";
import { writeZip, writeZipWithRawName } from "./helpers/zip.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-open-file-zip-"));
});

afterEach(async () => rm(root, { recursive: true, force: true }));

describe("bounded ZIP access", () => {
  it("lists deterministic entry metadata and reads only a selected entry", async () => {
    const path = join(root, "safe.zip");
    await writeZip(path, [
      { name: "b.txt", data: "bravo" },
      { name: "folder/a.txt", data: "alpha" }
    ]);
    const archive = await SafeZip.open(path, DEFAULT_LIMITS);
    expect(archive.entries.map(({ name, uncompressedSize, directory }) => ({ name, uncompressedSize, directory }))).toEqual([
      { name: "b.txt", uncompressedSize: 5, directory: false },
      { name: "folder/a.txt", uncompressedSize: 5, directory: false }
    ]);
    expect(await archive.readEntry("folder/a.txt")).toEqual(Buffer.from("alpha"));
    await expect(archive.readEntry("missing")).rejects.toMatchObject({ code: "FILE_PART_NOT_FOUND" });
  });

  it.each(["../escape.txt", "/absolute.txt", "C:/drive.txt", "folder\\escape.txt"])(
    "rejects unsafe entry path %s",
    async (name) => {
      const path = join(root, "unsafe.zip");
      await writeZipWithRawName(path, name);
      await expect(SafeZip.open(path, DEFAULT_LIMITS)).rejects.toMatchObject({
        code: "FILE_ARCHIVE_LIMIT_EXCEEDED"
      });
    }
  );

  it("rejects duplicate file names", async () => {
    const path = join(root, "duplicate.zip");
    await writeZip(path, [{ name: "same.txt", data: "a" }, { name: "same.txt", data: "b" }]);
    await expect(SafeZip.open(path, DEFAULT_LIMITS)).rejects.toMatchObject({
      code: "FILE_ARCHIVE_LIMIT_EXCEEDED"
    });
  });

  it("enforces entry count, entry size, expanded total, ratio, and recursion limits", async () => {
    const path = join(root, "limits.zip");
    await writeZip(path, [
      { name: "one.txt", data: "a".repeat(1000) },
      { name: "two.txt", data: "b".repeat(1000) }
    ]);
    for (const limits of [
      { maxArchiveEntries: 1 },
      { maxArchiveEntryBytes: 999 },
      { maxArchiveExpandedBytes: 1999 },
      { maxArchiveRatio: 2 }
    ]) {
      await expect(SafeZip.open(path, { ...DEFAULT_LIMITS, ...limits })).rejects.toMatchObject({
        code: "FILE_ARCHIVE_LIMIT_EXCEEDED"
      });
    }
    await expect(SafeZip.open(path, DEFAULT_LIMITS, DEFAULT_LIMITS.maxArchiveDepth + 1)).rejects.toMatchObject({
      code: "FILE_ARCHIVE_LIMIT_EXCEEDED"
    });
  });

  it("rejects Unix symbolic-link entries", async () => {
    const path = join(root, "link.zip");
    await writeZip(path, [{ name: "link", data: "target", mode: 0o120777 }]);
    await expect(SafeZip.open(path, DEFAULT_LIMITS)).rejects.toMatchObject({
      code: "FILE_ARCHIVE_LIMIT_EXCEEDED"
    });
  });

  it("checks the selected entry CRC before returning bytes", async () => {
    const path = join(root, "crc.zip");
    await writeZip(path, [{ name: "data.txt", data: "integrity" }]);
    const bytes = await readFile(path);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE((bytes.readUInt32LE(central + 16) ^ 0xffff_ffff) >>> 0, central + 16);
    await writeFile(path, bytes);
    const archive = await SafeZip.open(path, DEFAULT_LIMITS);
    await expect(archive.readEntry("data.txt")).rejects.toMatchObject({
      code: "FILE_ARCHIVE_LIMIT_EXCEEDED"
    });
  });
});
