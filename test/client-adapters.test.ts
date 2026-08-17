import { describe, expect, it, vi } from "vitest";

import {
  appendAttachmentLinks,
  installAttachmentSubmitAdapter,
  type SubmitAttachmentQueue
} from "../src/client/submit-adapter.js";

function submitQueue(overrides: Partial<SubmitAttachmentQueue> = {}): SubmitAttachmentQueue {
  return {
    hasDrafts: vi.fn(() => true),
    waitUntilReady: vi.fn(() =>
      Promise.resolve([
        {
          fileRef: "dsh-open-file://attachment/v1/session-a/018f3f08-a9d1-7d01-9128-112233445566",
          displayName: "report].pdf",
          fileId: "018f3f08-a9d1-7d01-9128-112233445566"
        }
      ])
    ),
    adoptAndClear: vi.fn(() => Promise.resolve()),
    ...overrides
  };
}

describe("narrow rc.6 conversation-submit adapter", () => {
  it("appends canonical links, preserves native image ids/mode, then adopts and clears", async () => {
    const original = vi.fn<(
      session: { readonly sessionId: string },
      text: string,
      imageIds: readonly unknown[],
      mode: unknown
    ) => Promise<void>>(() => Promise.resolve());
    const service = { sendSession: original };
    const queue = submitQueue();
    installAttachmentSubmitAdapter(service, queue);
    const imageIds = ["image-1"] as const;
    await service.sendSession({ sessionId: "session-a" }, "Read this", imageIds, "steer");
    expect(original).toHaveBeenCalledTimes(1);
    const call = original.mock.calls[0];
    expect(call?.[0]).toEqual({ sessionId: "session-a" });
    expect(call?.[1]).toBe(
      "Read this\n\n[Attached file: report\\].pdf](dsh-open-file://attachment/v1/session-a/018f3f08-a9d1-7d01-9128-112233445566)"
    );
    expect(call?.[2]).toBe(imageIds);
    expect(call?.[3]).toBe("steer");
    expect(queue.adoptAndClear).toHaveBeenCalledWith("session-a");
  });

  it("delegates byte-for-byte when the session has no file drafts", async () => {
    const original = vi.fn<(
      session: { readonly sessionId: string },
      text: string,
      imageIds: readonly unknown[],
      mode: unknown
    ) => Promise<void>>(() => Promise.resolve());
    const service = { sendSession: original };
    const queue = submitQueue({ hasDrafts: () => false });
    installAttachmentSubmitAdapter(service, queue);
    const target = { sessionId: "session-a" };
    const images = ["native"];
    await service.sendSession(target, "exact", images, "queue");
    expect(original).toHaveBeenCalledWith(target, "exact", images, "queue");
    expect(queue.waitUntilReady).not.toHaveBeenCalled();
  });

  it("retains drafts when the original submit fails and restores on dispose", async () => {
    const failure = new Error("send failed");
    const original = vi.fn<(
      session: { readonly sessionId: string },
      text: string,
      imageIds: readonly unknown[],
      mode: unknown
    ) => Promise<void>>(() => Promise.reject(failure));
    const service = { sendSession: original };
    const queue = submitQueue();
    const dispose = installAttachmentSubmitAdapter(service, queue);
    const wrapped = service.sendSession;
    await expect(service.sendSession({ sessionId: "session-a" }, "x", [], "queue")).rejects.toBe(failure);
    expect(queue.adoptAndClear).not.toHaveBeenCalled();
    dispose();
    expect(service.sendSession).toBe(original);
    expect(service.sendSession).not.toBe(wrapped);
  });

  it("fails with an explicit compatibility error when the concrete seam changes", () => {
    expect(() => installAttachmentSubmitAdapter({}, submitQueue())).toThrowError(
      expect.objectContaining({ code: "FILE_WEB_COMPATIBILITY" })
    );
  });
});

describe("attachment prompt projection", () => {
  it("adds links after text and supports an empty prompt", () => {
    const ready = [
      { fileRef: "dsh-open-file://attachment/v1/s/f", displayName: "a.md", fileId: "f" },
      { fileRef: "dsh-open-file://attachment/v1/s/g", displayName: "b.txt", fileId: "g" }
    ];
    expect(appendAttachmentLinks("question", ready)).toBe(
      "question\n\n[Attached file: a.md](dsh-open-file://attachment/v1/s/f)\n[Attached file: b.txt](dsh-open-file://attachment/v1/s/g)"
    );
    expect(appendAttachmentLinks("", ready)).toBe(
      "[Attached file: a.md](dsh-open-file://attachment/v1/s/f)\n[Attached file: b.txt](dsh-open-file://attachment/v1/s/g)"
    );
  });
});
