import { open as openZip, type Entry, type ZipFile } from "yauzl";

import type { OpenFileLimits } from "../contracts.js";
import { OpenFileError } from "../errors.js";

export interface SafeZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly directory: boolean;
}

interface IndexedEntry extends SafeZipEntry {
  readonly raw: Entry;
}

function archiveError(message: string, cause?: unknown): OpenFileError {
  return new OpenFileError("FILE_ARCHIVE_LIMIT_EXCEEDED", message, undefined, { cause });
}

function validateName(name: string): void {
  const segments = name.split("/");
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/u.test(name) ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    throw archiveError("The archive contains an unsafe entry path.");
  }
}

function isSymbolicLink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function updateCrc32(current: number, bytes: Buffer): number {
  let crc = current;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb8_8320);
    }
  }
  return crc >>> 0;
}

function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZip(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true
      },
      (error, archive) => {
        if (error !== null) reject(archiveError("The ZIP container is invalid.", error));
        else if (archive === undefined) reject(archiveError("The ZIP container could not be opened."));
        else resolve(archive);
      }
    );
  });
}

async function indexArchive(path: string, limits: Readonly<OpenFileLimits>): Promise<IndexedEntry[]> {
  const archive = await openArchive(path);
  try {
    return await new Promise<IndexedEntry[]>((resolve, reject) => {
      const indexed: IndexedEntry[] = [];
      const names = new Set<string>();
      let expanded = 0;
      const fail = (error: unknown): void => {
        reject(error instanceof OpenFileError ? error : archiveError("The ZIP container is invalid.", error));
      };
      archive.once("error", fail);
      archive.on("entry", (entry: Entry) => {
        try {
          validateName(entry.fileName);
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw archiveError("Encrypted ZIP entries are not supported.");
          }
          if (isSymbolicLink(entry)) throw archiveError("Symbolic-link ZIP entries are not allowed.");
          const canonicalName = entry.fileName.normalize("NFC");
          if (names.has(canonicalName)) throw archiveError("Duplicate ZIP entry names are not allowed.");
          names.add(canonicalName);
          if (indexed.length + 1 > limits.maxArchiveEntries) {
            throw archiveError("The archive entry-count limit is exceeded.");
          }
          if (entry.uncompressedSize > limits.maxArchiveEntryBytes) {
            throw archiveError("An archive entry exceeds the expanded-size limit.");
          }
          expanded += entry.uncompressedSize;
          if (!Number.isSafeInteger(expanded) || expanded > limits.maxArchiveExpandedBytes) {
            throw archiveError("The archive expanded-size limit is exceeded.");
          }
          const directory = entry.fileName.endsWith("/");
          const ratio =
            entry.uncompressedSize === 0
              ? 0
              : entry.compressedSize === 0
                ? Number.POSITIVE_INFINITY
                : entry.uncompressedSize / entry.compressedSize;
          if (!directory && ratio > limits.maxArchiveRatio) {
            throw archiveError("The archive compression-ratio limit is exceeded.");
          }
          indexed.push(
            Object.freeze({
              name: entry.fileName,
              compressedSize: entry.compressedSize,
              uncompressedSize: entry.uncompressedSize,
              crc32: entry.crc32,
              directory,
              raw: entry
            })
          );
          archive.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      archive.once("end", () => resolve(indexed));
      archive.readEntry();
    });
  } finally {
    archive.close();
  }
}

async function readIndexedEntry(
  path: string,
  selected: SafeZipEntry,
  maximumBytes: number
): Promise<Buffer> {
  const archive = await openArchive(path);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof OpenFileError ? error : archiveError("The ZIP entry could not be read.", error));
      };
      archive.once("error", fail);
      archive.on("entry", (entry: Entry) => {
        if (settled) return;
        if (entry.fileName !== selected.name) {
          archive.readEntry();
          return;
        }
        if (
          entry.uncompressedSize !== selected.uncompressedSize ||
          entry.compressedSize !== selected.compressedSize ||
          entry.crc32 !== selected.crc32
        ) {
          fail(archiveError("The ZIP container changed after inspection."));
          return;
        }
        archive.openReadStream(entry, (error, stream) => {
          if (error !== null || stream === undefined) {
            fail(error ?? new Error("missing ZIP stream"));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          let crc32 = 0xffff_ffff;
          stream.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maximumBytes) {
              stream.destroy(archiveError("The ZIP entry exceeds the read limit."));
              return;
            }
            crc32 = updateCrc32(crc32, chunk);
            chunks.push(chunk);
          });
          stream.once("error", fail);
          stream.once("end", () => {
            if (settled) return;
            if (received !== selected.uncompressedSize) {
              fail(archiveError("The ZIP entry size is inconsistent."));
              return;
            }
            if ((crc32 ^ 0xffff_ffff) >>> 0 !== selected.crc32 >>> 0) {
              fail(archiveError("The ZIP entry CRC is inconsistent."));
              return;
            }
            settled = true;
            resolve(Buffer.concat(chunks));
          });
        });
      });
      archive.once("end", () => {
        if (!settled) fail(new OpenFileError("FILE_PART_NOT_FOUND", "The ZIP entry does not exist."));
      });
      archive.readEntry();
    });
  } finally {
    archive.close();
  }
}

export class SafeZip {
  readonly entries: readonly SafeZipEntry[];
  private readonly path: string;
  private readonly limits: Readonly<OpenFileLimits>;

  private constructor(path: string, limits: Readonly<OpenFileLimits>, entries: readonly IndexedEntry[]) {
    this.path = path;
    this.limits = limits;
    this.entries = Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          name: entry.name,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          crc32: entry.crc32,
          directory: entry.directory
        })
      )
    );
  }

  static async open(
    path: string,
    limits: Readonly<OpenFileLimits>,
    depth = 0
  ): Promise<SafeZip> {
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > limits.maxArchiveDepth) {
      throw archiveError("The nested-archive depth limit is exceeded.");
    }
    return new SafeZip(path, limits, await indexArchive(path, limits));
  }

  async readEntry(name: string): Promise<Buffer> {
    const entry = this.entries.find((candidate) => candidate.name === name && !candidate.directory);
    if (entry === undefined) {
      throw new OpenFileError("FILE_PART_NOT_FOUND", "The ZIP entry does not exist.");
    }
    return readIndexedEntry(this.path, entry, this.limits.maxArchiveEntryBytes);
  }
}
