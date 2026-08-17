// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { attachmentContentUrl, BrowserAttachmentUploadApi } from "../src/client/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser streaming transport", () => {
  it("builds an encoded same-origin attachment content URL", () => {
    expect(
      attachmentContentUrl(
        "session / 中文",
        "dsh-open-file://attachment/v1/session / 中文/018f3f08-a9d1-7d01-9128-112233445566"
      )
    ).toBe(
      "/dsh-open-file/v1/attachments/content?sessionId=session+%2F+%E4%B8%AD%E6%96%87&fileRef=dsh-open-file%3A%2F%2Fattachment%2Fv1%2Fsession+%2F+%E4%B8%AD%E6%96%87%2F018f3f08-a9d1-7d01-9128-112233445566"
    );
  });

  it("prepares with metadata JSON only and same-origin credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            uploadId: "u",
            fileId: "f",
            size: 6,
            putUrl: "/put",
            commitUrl: "/commit",
            deleteUrl: "/delete"
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    vi.stubGlobal("fetch", fetch);
    const api = new BrowserAttachmentUploadApi();
    await api.prepare(
      "session-a",
      new File(["secret"], "notes.txt", { type: "text/plain" })
    );
    const init = fetch.mock.calls[0]?.[1];
    if (init === undefined) throw new Error("missing fetch init");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe(
      JSON.stringify({ sessionId: "session-a", name: "notes.txt", size: 6, declaredType: "text/plain" })
    );
    expect(typeof init.body).toBe("string");
    expect(init.body as string).not.toContain("c2VjcmV0");
  });

  it("sends the File itself as an octet-stream XHR body and reports progress", async () => {
    let sent: Document | XMLHttpRequestBodyInit | null | undefined;
    let contentType: string | undefined;
    class FakeRequest {
      status = 200;
      response = { received: 6, sourceSha256: "a".repeat(64) };
      responseType: XMLHttpRequestResponseType = "";
      withCredentials = false;
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(): void {}
      setRequestHeader(name: string, value: string): void {
        if (name === "Content-Type") contentType = value;
      }
      send(body?: Document | XMLHttpRequestBodyInit | null): void {
        sent = body;
        this.upload.onprogress?.({ loaded: 3, total: 6 } as ProgressEvent);
        queueMicrotask(() => this.onload?.());
      }
      abort(): void {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const selected = new File(["secret"], "notes.txt");
    const progress = vi.fn();
    const result = await new BrowserAttachmentUploadApi().upload(
      "/put",
      selected,
      progress,
      new AbortController().signal
    );
    expect(sent).toBe(selected);
    expect(contentType).toBe("application/octet-stream");
    expect(progress).toHaveBeenCalledWith(3, 6);
    expect(result.received).toBe(6);
  });
});
