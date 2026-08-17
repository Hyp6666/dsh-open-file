import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "../src/contracts.js";
import { parseAttachmentRef } from "../src/references.js";
import { WorkspaceRepository } from "../src/storage/repository.js";
import { UploadService } from "../src/upload/service.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dsh-open-file-upload-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function service(overrides: Partial<typeof DEFAULT_LIMITS> = {}): UploadService {
  let sequence = 0;
  return new UploadService({
    resolveWorkspace: (sessionId) => Promise.resolve(sessionId === "session-a" ? workspace : null),
    limits: { ...DEFAULT_LIMITS, ...overrides },
    createUploadId: () => `upload-${++sequence}`,
    createFileId: () => `018f3f08-a9d1-7d01-9128-1122334455${String(sequence).padStart(2, "0")}`,
    now: () => new Date("2026-08-17T00:00:00.000Z")
  });
}

describe("streaming upload state machine", () => {
  it("prepares, streams raw bytes, commits, adopts, and resolves a traceable file", async () => {
    const uploads = service();
    const prepared = await uploads.prepare({
      sessionId: "session-a",
      name: "notes.txt",
      size: 11,
      declaredType: "text/plain"
    });
    expect(prepared.uploadId).toBe("upload-1");
    expect(prepared.fileId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(prepared.size).toBe(11);

    const streamed = await uploads.write({
      sessionId: "session-a",
      uploadId: prepared.uploadId,
      bytes: Readable.from([Buffer.from("hello "), Buffer.from("world")])
    });
    expect(streamed).toEqual({ received: 11, sourceSha256: digest("hello world") });

    const committed = await uploads.commit({
      sessionId: "session-a",
      uploadId: prepared.uploadId,
      expectedSha256: digest("hello world")
    });
    expect(parseAttachmentRef(committed.fileRef)).toMatchObject({
      sessionId: "session-a",
      fileId: prepared.fileId
    });
    expect(committed).toMatchObject({
      displayName: "notes.txt",
      detectedType: "text/plain",
      sourceSha256: digest("hello world"),
      size: 11,
      draft: true
    });

    await uploads.adopt({ sessionId: "session-a", fileId: prepared.fileId });
    expect((await uploads.resolve({ sessionId: "session-a", fileRef: committed.fileRef })).draft).toBe(false);
  });

  it("keeps commit idempotent without duplicating source data", async () => {
    const uploads = service();
    const prepared = await uploads.prepare({ sessionId: "session-a", name: "x", size: 1 });
    await uploads.write({
      sessionId: "session-a",
      uploadId: prepared.uploadId,
      bytes: Readable.from(Buffer.from("x"))
    });
    const first = await uploads.commit({ sessionId: "session-a", uploadId: prepared.uploadId });
    const second = await uploads.commit({ sessionId: "session-a", uploadId: prepared.uploadId });
    expect(second).toEqual(first);
    const repository = await WorkspaceRepository.open(workspace, "session-a");
    expect(await repository.readSource(prepared.fileId)).toEqual(Buffer.from("x"));
  });

  it("rejects unknown sessions and cross-session access", async () => {
    const uploads = service();
    await expect(
      uploads.prepare({ sessionId: "session-b", name: "x", size: 1 })
    ).rejects.toMatchObject({ code: "FILE_SESSION_MISMATCH" });
    const prepared = await uploads.prepare({ sessionId: "session-a", name: "x", size: 1 });
    await expect(
      uploads.write({
        sessionId: "session-b",
        uploadId: prepared.uploadId,
        bytes: Readable.from(Buffer.from("x"))
      })
    ).rejects.toMatchObject({ code: "FILE_SESSION_MISMATCH" });
  });

  it("enforces file, draft count, and draft total limits before upload", async () => {
    const uploads = service({ maxFileBytes: 4, maxDraftFiles: 1, maxDraftBytes: 4 });
    await expect(
      uploads.prepare({ sessionId: "session-a", name: "large", size: 5 })
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_TOO_LARGE" });
    await uploads.prepare({ sessionId: "session-a", name: "one", size: 4 });
    await expect(
      uploads.prepare({ sessionId: "session-a", name: "two", size: 1 })
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_TOO_LARGE" });
  });

  it("cleans an incomplete stream and permits retry with the same upload id", async () => {
    const uploads = service();
    const prepared = await uploads.prepare({ sessionId: "session-a", name: "x", size: 4 });
    await expect(
      uploads.write({
        sessionId: "session-a",
        uploadId: prepared.uploadId,
        bytes: Readable.from(Buffer.from("no"))
      })
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_INCOMPLETE" });

    await uploads.write({
      sessionId: "session-a",
      uploadId: prepared.uploadId,
      bytes: Readable.from(Buffer.from("okay"))
    });
    const result = await uploads.commit({ sessionId: "session-a", uploadId: prepared.uploadId });
    expect(result.sourceSha256).toBe(digest("okay"));
  });

  it("rejects excess streamed bytes and a mismatched source hash", async () => {
    const uploads = service();
    const tooLong = await uploads.prepare({ sessionId: "session-a", name: "x", size: 2 });
    await expect(
      uploads.write({
        sessionId: "session-a",
        uploadId: tooLong.uploadId,
        bytes: Readable.from(Buffer.from("three"))
      })
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_TOO_LARGE" });

    const mismatch = await uploads.prepare({ sessionId: "session-a", name: "y", size: 1 });
    await uploads.write({
      sessionId: "session-a",
      uploadId: mismatch.uploadId,
      bytes: Readable.from(Buffer.from("y"))
    });
    await expect(
      uploads.commit({
        sessionId: "session-a",
        uploadId: mismatch.uploadId,
        expectedSha256: "0".repeat(64)
      })
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_INCOMPLETE" });
  });

  it("maps an aborted stream to FILE_ABORTED and removes partial bytes", async () => {
    const uploads = service();
    const prepared = await uploads.prepare({ sessionId: "session-a", name: "x", size: 4 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploads.write({
        sessionId: "session-a",
        uploadId: prepared.uploadId,
        bytes: Readable.from(Buffer.from("okay")),
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "FILE_ABORTED" });
    const repository = await WorkspaceRepository.open(workspace, "session-a");
    expect((await readdir(repository.layout.incoming)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("times out a stalled upload stream and removes partial bytes", async () => {
    const uploads = service({ uploadTimeoutMs: 10 });
    const prepared = await uploads.prepare({ sessionId: "session-a", name: "x", size: 4 });
    const stalled = new Readable({ read: () => undefined });
    await expect(
      Promise.race([
        uploads.write({
          sessionId: "session-a",
          uploadId: prepared.uploadId,
          bytes: stalled
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("test deadline")), 100))
      ])
    ).rejects.toMatchObject({ code: "FILE_ABORTED" });
    const repository = await WorkspaceRepository.open(workspace, "session-a");
    expect((await readdir(repository.layout.incoming)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("cancels prepared uploads and removes only committed drafts", async () => {
    const uploads = service();
    const pending = await uploads.prepare({ sessionId: "session-a", name: "pending", size: 1 });
    await uploads.cancel({ sessionId: "session-a", uploadId: pending.uploadId });
    await expect(
      uploads.write({
        sessionId: "session-a",
        uploadId: pending.uploadId,
        bytes: Readable.from(Buffer.from("x"))
      })
    ).rejects.toMatchObject({ code: "FILE_INVALID_ARGUMENT" });

    const committed = await uploads.prepare({ sessionId: "session-a", name: "draft", size: 1 });
    await uploads.write({
      sessionId: "session-a",
      uploadId: committed.uploadId,
      bytes: Readable.from(Buffer.from("x"))
    });
    await uploads.commit({ sessionId: "session-a", uploadId: committed.uploadId });
    await uploads.cancel({ sessionId: "session-a", uploadId: committed.uploadId });
    const repository = await WorkspaceRepository.open(workspace, "session-a");
    await expect(repository.readMetadata(committed.fileId)).rejects.toMatchObject({
      code: "FILE_PART_NOT_FOUND"
    });
  });

  it("rejects commit before a complete upload", async () => {
    const uploads = service();
    const prepared = await uploads.prepare({ sessionId: "session-a", name: "x", size: 1 });
    await expect(
      uploads.commit({ sessionId: "session-a", uploadId: prepared.uploadId })
    ).rejects.toMatchObject({ code: "FILE_UPLOAD_INCOMPLETE" });
  });
});
