import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOpenFileHttpHandler } from "../src/http/router.js";
import { UploadService } from "../src/upload/service.js";

let workspace: string;
let uploads: UploadService;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dsh-open-file-http-"));
  uploads = new UploadService({
    resolveWorkspace: (sessionId) => Promise.resolve(sessionId === "session-a" ? workspace : null)
  });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

class MockRequest extends Readable {
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly url: string;
  private body: Buffer | null;

  constructor(method: string, url: string, headers: IncomingHttpHeaders, body: Buffer) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  override _read(): void {
    if (this.body !== null) {
      this.push(this.body);
      this.body = null;
    }
    this.push(null);
  }
}

class MockResponse extends Writable {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  get headersSent(): boolean {
    return false;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  get json(): unknown {
    return JSON.parse(this.text) as unknown;
  }
}

interface InvokeOptions {
  readonly method?: string;
  readonly body?: Buffer | string | Record<string, unknown>;
  readonly contentType?: string;
  readonly origin?: string | null;
  readonly secFetchSite?: string;
}

async function invoke(path: string, options: InvokeOptions = {}): Promise<MockResponse> {
  const method = options.method ?? "GET";
  const body =
    options.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(
            typeof options.body === "string" ? options.body : JSON.stringify(options.body),
            "utf8"
          );
  const headers: IncomingHttpHeaders = { host: "dsh.test" };
  if (options.origin !== null) headers.origin = options.origin ?? "http://dsh.test";
  if (options.secFetchSite !== undefined) headers["sec-fetch-site"] = options.secFetchSite;
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  const request = new MockRequest(method, path, headers, body);
  const response = new MockResponse();
  const finished = once(response, "finish");
  createOpenFileHttpHandler(uploads)(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse
  );
  await finished;
  return response;
}

async function jsonRequest(
  path: string,
  method: string,
  body?: Record<string, unknown>
): Promise<MockResponse> {
  return body === undefined
    ? invoke(path, { method })
    : invoke(path, { method, body, contentType: "application/json" });
}

describe("same-origin streaming HTTP protocol", () => {
  it("completes prepare, raw PUT, commit, resolve, adopt, and draft delete", async () => {
    const prepare = await jsonRequest("/dsh-open-file/v1/uploads/prepare", "POST", {
      sessionId: "session-a",
      name: "hello.txt",
      size: 5
    });
    expect(prepare.statusCode).toBe(201);
    const prepared = prepare.json as {
      uploadId: string;
      fileId: string;
      putUrl: string;
      commitUrl: string;
      deleteUrl: string;
    };
    expect(prepared.putUrl).toContain(encodeURIComponent(prepared.uploadId));

    const put = await invoke(prepared.putUrl, {
      method: "PUT",
      contentType: "application/octet-stream",
      body: Buffer.from("hello")
    });
    expect(put.statusCode).toBe(200);
    const streamed = put.json as { received: number; sourceSha256: string };
    expect(streamed.received).toBe(5);
    expect(streamed.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);

    const commit = await jsonRequest(prepared.commitUrl, "POST", { sessionId: "session-a" });
    expect(commit.statusCode).toBe(201);
    const metadata = commit.json as { fileRef: string; fileId: string; draft: boolean };
    expect(metadata).toMatchObject({ fileId: prepared.fileId, draft: true });

    const resolved = await jsonRequest("/dsh-open-file/v1/attachments/resolve", "POST", {
      sessionId: "session-a",
      fileRef: metadata.fileRef
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json).toMatchObject({ displayName: "hello.txt", size: 5 });

    const content = await invoke(
      `/dsh-open-file/v1/attachments/content?sessionId=session-a&fileRef=${encodeURIComponent(metadata.fileRef)}`,
      { origin: null, secFetchSite: "same-origin" }
    );
    expect(content.statusCode).toBe(200);
    expect(content.text).toBe("hello");
    expect(content.getHeader("content-type")).toBe("text/plain; charset=utf-8");
    expect(content.getHeader("content-disposition")).toContain("inline");
    expect(content.getHeader("cross-origin-resource-policy")).toBe("same-origin");

    const adopt = await jsonRequest(
      `/dsh-open-file/v1/attachments/${encodeURIComponent(prepared.fileId)}/adopt`,
      "POST",
      { sessionId: "session-a" }
    );
    expect(adopt.statusCode).toBe(204);

    const removal = await invoke(prepared.deleteUrl, { method: "DELETE" });
    expect(removal.statusCode).toBe(400);
    expect(removal.json).toMatchObject({ error: { code: "FILE_INVALID_ARGUMENT" } });
  });

  it("rejects cross-origin requests before reading their body", async () => {
    const response = await invoke("/dsh-open-file/v1/uploads/prepare", {
      method: "POST",
      origin: "https://evil.example",
      contentType: "application/json",
      body: { sessionId: "session-a", name: "x", size: 1 }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json).toMatchObject({ error: { code: "FILE_SESSION_MISMATCH" } });
  });

  it("allows an origin-less top-level content navigation but rejects an explicit cross-site fetch", async () => {
    const prepare = await jsonRequest("/dsh-open-file/v1/uploads/prepare", "POST", {
      sessionId: "session-a",
      name: "preview.txt",
      size: 7
    });
    const prepared = prepare.json as { putUrl: string; commitUrl: string };
    await invoke(prepared.putUrl, {
      method: "PUT",
      contentType: "application/octet-stream",
      body: Buffer.from("preview")
    });
    const commit = await jsonRequest(prepared.commitUrl, "POST", { sessionId: "session-a" });
    const metadata = commit.json as { fileRef: string };
    const contentUrl =
      `/dsh-open-file/v1/attachments/content?sessionId=session-a&fileRef=${encodeURIComponent(metadata.fileRef)}`;

    const navigation = await invoke(contentUrl, { origin: null });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.text).toBe("preview");

    const crossSite = await invoke(contentUrl, {
      origin: null,
      secFetchSite: "cross-site"
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it("requires exact methods and content types", async () => {
    const wrongMethod = await invoke("/dsh-open-file/v1/uploads/prepare");
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.getHeader("allow")).toBe("POST");

    const wrongType = await invoke("/dsh-open-file/v1/uploads/prepare", {
      method: "POST",
      contentType: "text/plain",
      body: "{}"
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json).toMatchObject({ error: { code: "FILE_TYPE_UNSUPPORTED" } });
  });

  it("never accepts whole-file Base64 JSON on the binary endpoint", async () => {
    const prepare = await jsonRequest("/dsh-open-file/v1/uploads/prepare", "POST", {
      sessionId: "session-a",
      name: "x.bin",
      size: 3
    });
    const prepared = prepare.json as { putUrl: string };
    const response = await invoke(prepared.putUrl, {
      method: "PUT",
      contentType: "application/json",
      body: { data: Buffer.from("abc").toString("base64") }
    });
    expect(response.statusCode).toBe(415);
  });

  it("bounds JSON bodies", async () => {
    const response = await jsonRequest("/dsh-open-file/v1/uploads/prepare", "POST", {
      sessionId: "session-a",
      name: "x".repeat(70_000),
      size: 1
    });
    expect(response.statusCode).toBe(413);
    expect(response.json).toMatchObject({ error: { code: "FILE_UPLOAD_TOO_LARGE" } });
  });

  it("does not expose internal paths or file bytes in errors", async () => {
    const response = await jsonRequest("/dsh-open-file/v1/attachments/resolve", "POST", {
      sessionId: "session-a",
      fileRef: "bad"
    });
    expect(response.statusCode).toBe(400);
    expect(response.text).not.toContain(workspace);
    expect(response.text).not.toContain("source.bin");
  });
});
