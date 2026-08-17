import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { OpenFileError } from "../errors.js";
import { createAttachmentRef, parseAttachmentRef } from "../references.js";
import { sanitizeDisplayName } from "../security/name.js";
import { readJson, writeJsonAtomic } from "./json.js";
import { assertContainedPath, prepareSessionLayout, type SessionLayout } from "./layout.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface StoredFileMetadata {
  readonly version: 1;
  readonly fileId: string;
  readonly sessionId: string;
  readonly fileRef: string;
  readonly displayName: string;
  readonly declaredType: string | null;
  readonly detectedType: string;
  readonly sourceSha256: string;
  readonly size: number;
  readonly createdAt: string;
  readonly draft: boolean;
}

export interface StoredManifest {
  readonly version: 1;
  readonly file_ref: string;
  readonly source_sha256: string;
  readonly parser: string;
  readonly parts: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface PublishInput {
  readonly uploadId: string;
  readonly fileId: string;
  readonly displayName: string;
  readonly declaredType: string | null;
  readonly detectedType: string;
  readonly sourceSha256: string;
  readonly size: number;
  readonly createdAt: string;
  readonly draft: boolean;
  readonly manifest: {
    readonly version: 1;
    readonly parser: string;
    readonly parts: readonly unknown[];
    readonly [key: string]: unknown;
  };
}

export interface PublishedFile {
  readonly fileRef: string;
  readonly directory: string;
  readonly metadata: StoredFileMetadata;
}

export interface ResolvedSourceFile {
  readonly path: string;
  readonly metadata: StoredFileMetadata;
}

function validateIdentifier(value: string, kind: "upload" | "file"): void {
  const valid = kind === "upload" ? IDENTIFIER_PATTERN.test(value) : FILE_ID_PATTERN.test(value);
  if (!valid) throw new OpenFileError("FILE_INVALID_ARGUMENT", `The ${kind} identifier is invalid.`);
}

async function regularFile(path: string, code: "FILE_UPLOAD_INCOMPLETE" | "FILE_PART_NOT_FOUND"): Promise<void> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink() || !information.isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new OpenFileError(code, "The requested file is not available.", undefined, { cause: error });
  }
}

export class WorkspaceRepository {
  readonly layout: SessionLayout;
  readonly sessionId: string;

  private constructor(layout: SessionLayout, sessionId: string) {
    this.layout = layout;
    this.sessionId = sessionId;
  }

  static async open(workspace: string, sessionId: string): Promise<WorkspaceRepository> {
    return new WorkspaceRepository(await prepareSessionLayout(workspace, sessionId), sessionId);
  }

  async createIncoming(uploadId: string): Promise<Awaited<ReturnType<typeof open>>> {
    validateIdentifier(uploadId, "upload");
    const path = this.incomingPath(uploadId);
    return open(path, "wx", 0o600);
  }

  incomingPath(uploadId: string): string {
    validateIdentifier(uploadId, "upload");
    const path = join(this.layout.incoming, `${uploadId}.part`);
    assertContainedPath(this.layout.workspace, path);
    return path;
  }

  fileDirectory(fileId: string): string {
    validateIdentifier(fileId, "file");
    const path = join(this.layout.files, fileId.toLowerCase());
    assertContainedPath(this.layout.workspace, path);
    return path;
  }

  async publishIncoming(input: PublishInput): Promise<PublishedFile> {
    validateIdentifier(input.uploadId, "upload");
    validateIdentifier(input.fileId, "file");
    if (!Number.isSafeInteger(input.size) || input.size < 0 || !/^[a-f0-9]{64}$/u.test(input.sourceSha256)) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The publication metadata is invalid.");
    }
    const finalDirectory = this.fileDirectory(input.fileId);
    try {
      await lstat(finalDirectory);
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The file identifier is already published.");
    } catch (error) {
      if (error instanceof OpenFileError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    const incoming = this.incomingPath(input.uploadId);
    await regularFile(incoming, "FILE_UPLOAD_INCOMPLETE");
    const information = await stat(incoming);
    if (information.size !== input.size) {
      throw new OpenFileError("FILE_UPLOAD_INCOMPLETE", "The uploaded byte count is incomplete.");
    }

    const temporaryDirectory = join(this.layout.files, `.${input.fileId}.${randomUUID()}.part`);
    assertContainedPath(this.layout.workspace, temporaryDirectory);
    await mkdir(temporaryDirectory, { mode: 0o700 });
    try {
      const source = join(temporaryDirectory, "source.bin");
      await rename(incoming, source);
      await chmod(source, 0o400).catch(() => undefined);
      const fileRef = createAttachmentRef(this.sessionId, input.fileId);
      const metadata: StoredFileMetadata = Object.freeze({
        version: 1,
        fileId: input.fileId.toLowerCase(),
        sessionId: this.sessionId,
        fileRef,
        displayName: sanitizeDisplayName(input.displayName),
        declaredType: input.declaredType,
        detectedType: input.detectedType,
        sourceSha256: input.sourceSha256,
        size: input.size,
        createdAt: input.createdAt,
        draft: input.draft
      });
      const manifest: StoredManifest = {
        ...input.manifest,
        version: 1,
        file_ref: fileRef,
        source_sha256: input.sourceSha256,
        parser: input.manifest.parser,
        parts: input.manifest.parts
      };
      await writeJsonAtomic(this.layout.workspace, join(temporaryDirectory, "metadata.json"), metadata);
      await writeJsonAtomic(this.layout.workspace, join(temporaryDirectory, "manifest.json"), manifest);
      await mkdir(join(temporaryDirectory, "parts"), { mode: 0o700 });
      await mkdir(join(temporaryDirectory, "renders"), { mode: 0o700 });
      await rename(temporaryDirectory, finalDirectory);
      return Object.freeze({ fileRef, directory: finalDirectory, metadata });
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readMetadata(fileId: string): Promise<StoredFileMetadata> {
    const path = join(this.fileDirectory(fileId), "metadata.json");
    try {
      return await readJson<StoredFileMetadata>(this.layout.workspace, path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new OpenFileError("FILE_PART_NOT_FOUND", "The file does not exist.");
      }
      throw error;
    }
  }

  async readManifest(fileId: string): Promise<StoredManifest> {
    const path = join(this.fileDirectory(fileId), "manifest.json");
    try {
      return await readJson<StoredManifest>(this.layout.workspace, path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new OpenFileError("FILE_PART_NOT_FOUND", "The file does not exist.");
      }
      throw error;
    }
  }

  async readSource(fileId: string): Promise<Buffer> {
    const path = this.sourcePath(fileId);
    await regularFile(path, "FILE_PART_NOT_FOUND");
    return readFile(path);
  }

  sourcePath(fileId: string): string {
    const path = join(this.fileDirectory(fileId), "source.bin");
    assertContainedPath(this.layout.workspace, path);
    return path;
  }

  artifactPath(fileId: string, kind: "parts" | "renders", name: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(name)) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The artifact name is invalid.");
    }
    const path = join(this.fileDirectory(fileId), kind, name);
    assertContainedPath(this.layout.workspace, path);
    return path;
  }

  async writeManifest(fileId: string, manifest: StoredManifest): Promise<void> {
    const path = join(this.fileDirectory(fileId), "manifest.json");
    await writeJsonAtomic(this.layout.workspace, path, manifest);
  }

  async resolveAttachment(fileRef: string): Promise<StoredFileMetadata> {
    const reference = parseAttachmentRef(fileRef);
    if (reference.sessionId !== this.sessionId) {
      throw new OpenFileError("FILE_SESSION_MISMATCH", "The file belongs to a different session.");
    }
    return this.readMetadata(reference.fileId);
  }

  async resolveSource(fileRef: string): Promise<ResolvedSourceFile> {
    const metadata = await this.resolveAttachment(fileRef);
    const path = this.sourcePath(metadata.fileId);
    await regularFile(path, "FILE_PART_NOT_FOUND");
    const information = await stat(path);
    if (information.size !== metadata.size) {
      throw new OpenFileError("FILE_PART_NOT_FOUND", "The requested file is not available.");
    }
    return Object.freeze({ path, metadata });
  }

  async adopt(fileId: string): Promise<void> {
    const directory = this.fileDirectory(fileId);
    const metadata = await this.readMetadata(fileId);
    if (!metadata.draft) return;
    await writeJsonAtomic(this.layout.workspace, join(directory, "metadata.json"), {
      ...metadata,
      draft: false
    });
  }

  async removeDraft(fileId: string): Promise<void> {
    const metadata = await this.readMetadata(fileId);
    if (!metadata.draft) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "Only an unattached draft may be removed.");
    }
    await rm(this.fileDirectory(fileId), { recursive: true, force: false });
  }
}
