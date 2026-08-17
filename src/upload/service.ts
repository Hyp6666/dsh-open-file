import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";

import { DEFAULT_LIMITS, type OpenFileLimits } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import { detectFileType } from "../files/detect.js";
import { createPartRef } from "../references.js";
import { readJson, writeJsonAtomic } from "../storage/json.js";
import {
  WorkspaceRepository,
  type ResolvedSourceFile,
  type StoredFileMetadata
} from "../storage/repository.js";

interface UploadRecord {
  readonly version: 1;
  readonly uploadId: string;
  readonly fileId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly declaredType: string | null;
  readonly size: number;
  readonly createdAt: string;
  readonly state: "prepared" | "uploaded" | "committed";
  readonly received?: number;
  readonly sourceSha256?: string;
  readonly committedMetadata?: StoredFileMetadata;
}

export interface UploadServiceOptions {
  readonly resolveWorkspace: (sessionId: string) => Promise<string | null>;
  readonly limits?: Readonly<OpenFileLimits>;
  readonly createUploadId?: () => string;
  readonly createFileId?: () => string;
  readonly now?: () => Date;
}

export interface PreparedUpload {
  readonly uploadId: string;
  readonly fileId: string;
  readonly size: number;
}

export interface StreamedUpload {
  readonly received: number;
  readonly sourceSha256: string;
}

function validateString(value: string, name: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new OpenFileError("FILE_INVALID_ARGUMENT", `${name} is invalid.`);
  }
}

function nodeCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export class UploadService {
  readonly limits: Readonly<OpenFileLimits>;
  private readonly resolveWorkspace: UploadServiceOptions["resolveWorkspace"];
  private readonly createUploadId: () => string;
  private readonly createFileId: () => string;
  private readonly now: () => Date;
  private readonly activeWrites = new Set<string>();

  constructor(options: UploadServiceOptions) {
    this.resolveWorkspace = options.resolveWorkspace;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    this.createUploadId = options.createUploadId ?? randomUUID;
    this.createFileId = options.createFileId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async prepare(input: {
    readonly sessionId: string;
    readonly name: string;
    readonly size: number;
    readonly declaredType?: string | null;
  }): Promise<PreparedUpload> {
    validateString(input.sessionId, "sessionId", 1024);
    validateString(input.name, "name", 4096);
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "size is invalid.");
    }
    if (input.size > this.limits.maxFileBytes) {
      throw new OpenFileError("FILE_UPLOAD_TOO_LARGE", "The file exceeds the configured size limit.");
    }
    if (input.declaredType !== undefined && input.declaredType !== null && input.declaredType.length > 255) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "declaredType is invalid.");
    }

    const repository = await this.repository(input.sessionId);
    const active = await this.listRecords(repository);
    const pending = active.filter((record) => record.state !== "committed");
    const total = pending.reduce((sum, record) => sum + record.size, 0);
    if (pending.length >= this.limits.maxDraftFiles || total + input.size > this.limits.maxDraftBytes) {
      throw new OpenFileError("FILE_UPLOAD_TOO_LARGE", "The attachment draft limit is exceeded.");
    }

    const record: UploadRecord = {
      version: 1,
      uploadId: this.createUploadId(),
      fileId: this.createFileId(),
      sessionId: input.sessionId,
      displayName: input.name,
      declaredType: input.declaredType ?? null,
      size: input.size,
      createdAt: this.now().toISOString(),
      state: "prepared"
    };
    await writeJsonAtomic(repository.layout.workspace, this.recordPath(repository, record.uploadId), record);
    return Object.freeze({ uploadId: record.uploadId, fileId: record.fileId, size: record.size });
  }

  async write(input: {
    readonly sessionId: string;
    readonly uploadId: string;
    readonly bytes: Readable;
    readonly signal?: AbortSignal;
  }): Promise<StreamedUpload> {
    const repository = await this.repository(input.sessionId);
    const record = await this.loadRecord(repository, input.uploadId);
    this.assertRecordSession(record, input.sessionId);
    if (record.state === "committed") {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "A committed upload cannot be overwritten.");
    }
    const lock = `${record.sessionId}:${record.uploadId}`;
    if (this.activeWrites.has(lock)) {
      throw new OpenFileError("FILE_INVALID_ARGUMENT", "The upload is already being written.");
    }
    this.activeWrites.add(lock);
    const incomingPath = repository.incomingPath(record.uploadId);
    await rm(incomingPath, { force: true });
    let handle: Awaited<ReturnType<WorkspaceRepository["createIncoming"]>> | undefined;
    let received = 0;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const hash = createHash("sha256");
    const abort = (): void => {
      input.bytes.destroy(new Error("upload aborted"));
    };
    try {
      if (input.signal?.aborted) throw new OpenFileError("FILE_ABORTED", "The upload was aborted.");
      handle = await repository.createIncoming(record.uploadId);
      if (input.signal?.aborted) throw new OpenFileError("FILE_ABORTED", "The upload was aborted.");
      input.signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        timedOut = true;
        input.bytes.destroy(new Error("upload timed out"));
      }, this.limits.uploadTimeoutMs);
      timeout.unref();
      for await (const value of input.bytes) {
        if (input.signal?.aborted) throw new OpenFileError("FILE_ABORTED", "The upload was aborted.");
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        received += chunk.length;
        if (received > record.size || received > this.limits.maxFileBytes) {
          throw new OpenFileError("FILE_UPLOAD_TOO_LARGE", "The streamed bytes exceed the declared size.");
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (received !== record.size) {
        throw new OpenFileError("FILE_UPLOAD_INCOMPLETE", "The streamed byte count is incomplete.");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      const sourceSha256 = hash.digest("hex");
      await this.saveRecord(repository, {
        ...record,
        state: "uploaded",
        received,
        sourceSha256
      });
      return Object.freeze({ received, sourceSha256 });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(incomingPath, { force: true }).catch(() => undefined);
      if (error instanceof OpenFileError) throw error;
      if (timedOut) {
        throw new OpenFileError("FILE_ABORTED", "The upload timed out.", undefined, { cause: error });
      }
      if (input.signal?.aborted) {
        throw new OpenFileError("FILE_ABORTED", "The upload was aborted.", undefined, { cause: error });
      }
      throw new OpenFileError("FILE_UPLOAD_INCOMPLETE", "The upload stream failed.", undefined, {
        cause: error
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      this.activeWrites.delete(lock);
    }
  }

  async commit(input: {
    readonly sessionId: string;
    readonly uploadId: string;
    readonly expectedSha256?: string;
  }): Promise<StoredFileMetadata> {
    const repository = await this.repository(input.sessionId);
    const record = await this.loadRecord(repository, input.uploadId);
    this.assertRecordSession(record, input.sessionId);
    if (record.state === "committed" && record.committedMetadata !== undefined) {
      return record.committedMetadata;
    }
    if (record.state !== "uploaded" || record.sourceSha256 === undefined || record.received !== record.size) {
      throw new OpenFileError("FILE_UPLOAD_INCOMPLETE", "The upload has not completed.");
    }
    if (
      input.expectedSha256 !== undefined &&
      (!/^[a-f0-9]{64}$/u.test(input.expectedSha256) || input.expectedSha256 !== record.sourceSha256)
    ) {
      throw new OpenFileError("FILE_UPLOAD_INCOMPLETE", "The uploaded source hash does not match.");
    }

    const detection = await detectFileType(repository.incomingPath(record.uploadId), record.displayName);
    if (detection.parser === "legacy-unsupported") {
      throw new OpenFileError(
        "FILE_LEGACY_FORMAT_UNSUPPORTED",
        "Legacy binary Office files are not supported."
      );
    }
    const partRef = createPartRef(record.sessionId, record.fileId, detection.family, "source");
    const published = await repository.publishIncoming({
      uploadId: record.uploadId,
      fileId: record.fileId,
      displayName: record.displayName,
      declaredType: record.declaredType,
      detectedType: detection.detectedType,
      sourceSha256: record.sourceSha256,
      size: record.size,
      createdAt: record.createdAt,
      draft: true,
      manifest: {
        version: 1,
        parser: detection.parser,
        parts: [
          {
            part_ref: partRef,
            kind: detection.family,
            locator: { kind: "source" },
            parser: detection.parser,
            source_sha256: record.sourceSha256
          }
        ]
      }
    });
    await this.saveRecord(repository, {
      ...record,
      state: "committed",
      committedMetadata: published.metadata
    });
    return published.metadata;
  }

  async cancel(input: { readonly sessionId: string; readonly uploadId: string }): Promise<void> {
    const repository = await this.repository(input.sessionId);
    const record = await this.loadRecord(repository, input.uploadId);
    this.assertRecordSession(record, input.sessionId);
    if (record.state === "committed") {
      await repository.removeDraft(record.fileId);
    } else {
      await rm(repository.incomingPath(record.uploadId), { force: true });
    }
    await rm(this.recordPath(repository, record.uploadId), { force: true });
  }

  async adopt(input: { readonly sessionId: string; readonly fileId: string }): Promise<void> {
    const repository = await this.repository(input.sessionId);
    await repository.adopt(input.fileId);
  }

  async resolve(input: {
    readonly sessionId: string;
    readonly fileRef: string;
  }): Promise<StoredFileMetadata> {
    const repository = await this.repository(input.sessionId);
    return repository.resolveAttachment(input.fileRef);
  }

  async resolveSource(input: {
    readonly sessionId: string;
    readonly fileRef: string;
  }): Promise<ResolvedSourceFile> {
    const repository = await this.repository(input.sessionId);
    return repository.resolveSource(input.fileRef);
  }

  private async repository(sessionId: string): Promise<WorkspaceRepository> {
    validateString(sessionId, "sessionId", 1024);
    const workspace = await this.resolveWorkspace(sessionId);
    if (workspace === null) {
      throw new OpenFileError("FILE_SESSION_MISMATCH", "The upload session is not active.");
    }
    return WorkspaceRepository.open(workspace, sessionId);
  }

  private recordPath(repository: WorkspaceRepository, uploadId: string): string {
    const partPath = repository.incomingPath(uploadId);
    return join(repository.layout.incoming, `${basename(partPath, ".part")}.json`);
  }

  private async loadRecord(
    repository: WorkspaceRepository,
    uploadId: string
  ): Promise<UploadRecord> {
    try {
      return await readJson<UploadRecord>(
        repository.layout.workspace,
        this.recordPath(repository, uploadId)
      );
    } catch (error) {
      if (nodeCode(error) === "ENOENT") {
        throw new OpenFileError("FILE_INVALID_ARGUMENT", "The upload does not exist.");
      }
      throw error;
    }
  }

  private async saveRecord(repository: WorkspaceRepository, record: UploadRecord): Promise<void> {
    await writeJsonAtomic(
      repository.layout.workspace,
      this.recordPath(repository, record.uploadId),
      record
    );
  }

  private assertRecordSession(record: UploadRecord, sessionId: string): void {
    if (record.sessionId !== sessionId) {
      throw new OpenFileError("FILE_SESSION_MISMATCH", "The upload belongs to a different session.");
    }
  }

  private async listRecords(repository: WorkspaceRepository): Promise<UploadRecord[]> {
    const names = await readdir(repository.layout.incoming);
    const records: UploadRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        records.push(
          await readJson<UploadRecord>(repository.layout.workspace, join(repository.layout.incoming, name))
        );
      } catch {
        // A malformed record is ignored here and remains unavailable to callers by its identifier.
      }
    }
    return records;
  }
}
