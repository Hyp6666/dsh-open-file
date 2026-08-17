// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { AttachmentQueue, AttachmentQueueError } from "../src/client/queue.js";
import type { AttachmentUploadApi } from "../src/client/api.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function file(name: string, value = "data"): File {
  return new File([value], name, { type: "application/octet-stream" });
}

function api(overrides: Partial<AttachmentUploadApi> = {}): AttachmentUploadApi {
  let sequence = 0;
  return {
    prepare: vi.fn(async (_sessionId, selected) => {
      sequence += 1;
      return {
        uploadId: `upload-${sequence}`,
        fileId: `file-${sequence}`,
        size: selected.size,
        putUrl: `/put/${sequence}`,
        commitUrl: `/commit/${sequence}`,
        deleteUrl: `/delete/${sequence}`
      };
    }),
    upload: vi.fn(async (_url, selected, onProgress) => {
      onProgress(selected.size / 2, selected.size);
      onProgress(selected.size, selected.size);
      return { received: selected.size, sourceSha256: String(selected.name.charCodeAt(0)).padStart(64, "0") };
    }),
    commit: vi.fn(async (_url, sessionId, prepared, streamed) => ({
      fileRef: `dsh-open-file://attachment/v1/${sessionId}/${prepared.fileId}`,
      fileId: prepared.fileId,
      displayName: `safe-${prepared.fileId}`,
      detectedType: "application/octet-stream",
      size: prepared.size,
      sourceSha256: streamed.sourceSha256,
      draft: true
    })),
    cancel: vi.fn(() => Promise.resolve()),
    adopt: vi.fn(() => Promise.resolve()),
    ...overrides
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("browser attachment queue", () => {
  it("preserves multi-file order while uploads finish out of order", async () => {
    const first = deferred<{ received: number; sourceSha256: string }>();
    const second = deferred<{ received: number; sourceSha256: string }>();
    const upload = vi
      .fn<AttachmentUploadApi["upload"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const queue = new AttachmentQueue(api({ upload }), { concurrency: 2 });
    queue.enqueue("session-a", [file("first.txt"), file("second.txt")]);
    await settle();
    second.resolve({ received: 4, sourceSha256: "b".repeat(64) });
    await settle();
    first.resolve({ received: 4, sourceSha256: "a".repeat(64) });
    const ready = await queue.waitUntilReady("session-a");
    expect(ready.map((item) => item.fileId)).toEqual(["file-1", "file-2"]);
    expect(queue.getSnapshot("session-a").map((item) => item.state)).toEqual(["ready", "ready"]);
  });

  it("publishes progress and stable draft card fields", async () => {
    const snapshots: string[] = [];
    const queue = new AttachmentQueue(api());
    queue.subscribe("session-a", () => {
      snapshots.push(JSON.stringify(queue.getSnapshot("session-a")));
    });
    queue.enqueue("session-a", [file("data.bin", "123456")]);
    await queue.waitUntilReady("session-a");
    const draft = queue.getSnapshot("session-a")[0];
    expect(draft).toMatchObject({
      displayName: "data.bin",
      size: 6,
      state: "ready",
      progress: 1,
      detectedType: "application/octet-stream"
    });
    expect(snapshots.some((snapshot) => snapshot.includes('"progress":0.5'))).toBe(true);
  });

  it("cancel leaves a retryable failed card; retry uses the same queue; remove deletes it", async () => {
    const pending = deferred<{ received: number; sourceSha256: string }>();
    const upload = vi
      .fn<AttachmentUploadApi["upload"]>()
      .mockImplementationOnce((_url, _file, _progress, signal) => {
        signal.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")));
        return pending.promise;
      })
      .mockResolvedValueOnce({ received: 4, sourceSha256: "a".repeat(64) });
    const backend = api({ upload });
    const queue = new AttachmentQueue(backend);
    const [id] = queue.enqueue("session-a", [file("x.txt")]);
    if (id === undefined) throw new Error("missing draft id");
    await settle();
    await queue.cancel("session-a", id);
    expect(queue.getSnapshot("session-a")[0]).toMatchObject({
      state: "failed",
      errorCode: "FILE_ABORTED"
    });
    queue.retry("session-a", id);
    await queue.waitUntilReady("session-a");
    expect(queue.getSnapshot("session-a")[0]?.state).toBe("ready");
    await queue.remove("session-a", id);
    expect(queue.getSnapshot("session-a")).toEqual([]);
    expect(backend.cancel).toHaveBeenCalled();
  });

  it("blocks submission on a failed upload and retains every card", async () => {
    const backend = api({ upload: () => Promise.reject(new Error("offline")) });
    const queue = new AttachmentQueue(backend);
    queue.enqueue("session-a", [file("failed.txt")]);
    await settle();
    await expect(queue.waitUntilReady("session-a")).rejects.toBeInstanceOf(AttachmentQueueError);
    expect(queue.getSnapshot("session-a")[0]).toMatchObject({ state: "failed" });
  });

  it("isolates sessions and adopts/clears only after explicit success choreography", async () => {
    const backend = api();
    const queue = new AttachmentQueue(backend);
    queue.enqueue("session-a", [file("a.txt")]);
    queue.enqueue("session-b", [file("b.txt")]);
    await Promise.all([queue.waitUntilReady("session-a"), queue.waitUntilReady("session-b")]);
    expect(queue.hasDrafts("session-a")).toBe(true);
    await queue.adoptAndClear("session-a");
    expect(queue.getSnapshot("session-a")).toEqual([]);
    expect(queue.getSnapshot("session-b")).toHaveLength(1);
    expect(backend.adopt).toHaveBeenCalledTimes(1);
  });

  it("enforces client draft count and total limits as visible failed cards", () => {
    const queue = new AttachmentQueue(api(), { maxDraftFiles: 1, maxDraftBytes: 4 });
    queue.enqueue("session-a", [file("first", "1234"), file("second", "5")]);
    expect(queue.getSnapshot("session-a")).toMatchObject([
      { state: "waiting" },
      { state: "failed", errorCode: "FILE_UPLOAD_TOO_LARGE" }
    ]);
  });
});
