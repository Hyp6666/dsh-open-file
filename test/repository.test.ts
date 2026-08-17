import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAttachmentRef } from "../src/references.js";
import { WorkspaceRepository } from "../src/storage/repository.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "dsh-open-file-repo-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

const fileId = "018f3f08-a9d1-7d01-9128-112233445566";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("workspace repository", () => {
  it("atomically publishes metadata, immutable source, and manifest", async () => {
    const workspace = await root();
    const repository = await WorkspaceRepository.open(workspace, "session-a");
    const upload = await repository.createIncoming("upload-a");
    await upload.write(Buffer.from("hello", "utf8"));
    await upload.close();

    const published = await repository.publishIncoming({
      uploadId: "upload-a",
      fileId,
      displayName: "hello.txt",
      declaredType: "text/plain",
      detectedType: "text/plain",
      sourceSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      size: 5,
      createdAt: "2026-08-17T00:00:00.000Z",
      draft: true,
      manifest: {
        version: 1,
        parser: "text/plain",
        parts: []
      }
    });

    expect(published.fileRef).toBe(createAttachmentRef("session-a", fileId));
    expect(await repository.readSource(fileId)).toEqual(Buffer.from("hello"));
    expect(await repository.readMetadata(fileId)).toMatchObject({
      fileId,
      sessionId: "session-a",
      displayName: "hello.txt",
      draft: true,
      sourceSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    });
    expect(JSON.parse(await readFile(join(published.directory, "manifest.json"), "utf8"))).toMatchObject({
      version: 1,
      file_ref: published.fileRef,
      source_sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    });
    expect((await stat(join(published.directory, "source.bin"))).isFile()).toBe(true);
  });

  it("never overwrites an already published file", async () => {
    const repository = await WorkspaceRepository.open(await root(), "session-a");
    for (const uploadId of ["first", "second"]) {
      const incoming = await repository.createIncoming(uploadId);
      await incoming.write(Buffer.from(uploadId));
      await incoming.close();
    }
    const input = {
      fileId,
      displayName: "x.bin",
      declaredType: null,
      detectedType: "application/octet-stream",
      sourceSha256: sha256("first"),
      size: 5,
      createdAt: "2026-08-17T00:00:00.000Z",
      draft: true,
      manifest: { version: 1 as const, parser: "binary", parts: [] }
    };
    await repository.publishIncoming({ ...input, uploadId: "first" });
    await expect(repository.publishIncoming({ ...input, uploadId: "second" })).rejects.toMatchObject({
      code: "FILE_INVALID_ARGUMENT"
    });
    expect(await repository.readSource(fileId)).toEqual(Buffer.from("first"));
  });

  it("separates sessions in the same workspace and rejects foreign refs", async () => {
    const workspace = await root();
    const first = await WorkspaceRepository.open(workspace, "session-a");
    const second = await WorkspaceRepository.open(workspace, "session-b");
    expect(first.layout.sessionRoot).not.toBe(second.layout.sessionRoot);
    await expect(first.readMetadata(fileId)).rejects.toMatchObject({ code: "FILE_PART_NOT_FOUND" });
    await expect(
      first.resolveAttachment(createAttachmentRef("session-b", fileId))
    ).rejects.toMatchObject({ code: "FILE_SESSION_MISMATCH" });
  });

  it("only removes plugin-owned drafts", async () => {
    const repository = await WorkspaceRepository.open(await root(), "session-a");
    const incoming = await repository.createIncoming("draft");
    await incoming.write(Buffer.from("draft"));
    await incoming.close();
    await repository.publishIncoming({
      uploadId: "draft",
      fileId,
      displayName: "draft.txt",
      declaredType: "text/plain",
      detectedType: "text/plain",
      sourceSha256: sha256("draft"),
      size: 5,
      createdAt: "2026-08-17T00:00:00.000Z",
      draft: true,
      manifest: { version: 1, parser: "text/plain", parts: [] }
    });
    await repository.adopt(fileId);
    await expect(repository.removeDraft(fileId)).rejects.toMatchObject({ code: "FILE_INVALID_ARGUMENT" });
    expect((await repository.readMetadata(fileId)).draft).toBe(false);
  });
});
