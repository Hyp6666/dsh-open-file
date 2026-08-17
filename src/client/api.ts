import type { OpenFileErrorCode } from "../contracts.js";
import { OpenFileError } from "../errors.js";

export interface PreparedBrowserUpload {
  readonly uploadId: string;
  readonly fileId: string;
  readonly size: number;
  readonly putUrl: string;
  readonly commitUrl: string;
  readonly deleteUrl: string;
}

export interface StreamedBrowserUpload {
  readonly received: number;
  readonly sourceSha256: string;
}

export interface ReadyBrowserAttachment {
  readonly fileRef: string;
  readonly fileId: string;
  readonly displayName: string;
  readonly detectedType: string;
  readonly size: number;
  readonly sourceSha256: string;
  readonly draft: boolean;
}

export interface ResolvedBrowserAttachment {
  readonly fileRef: string;
  readonly displayName: string;
  readonly detectedType: string;
  readonly size: number;
  readonly sourceSha256: string;
}

export interface AttachmentUploadApi {
  prepare(sessionId: string, file: File, signal?: AbortSignal): Promise<PreparedBrowserUpload>;
  upload(
    url: string,
    file: File,
    onProgress: (loaded: number, total: number) => void,
    signal: AbortSignal
  ): Promise<StreamedBrowserUpload>;
  commit(
    url: string,
    sessionId: string,
    prepared: PreparedBrowserUpload,
    streamed: StreamedBrowserUpload,
    signal?: AbortSignal
  ): Promise<ReadyBrowserAttachment>;
  cancel(url: string): Promise<void>;
  adopt(sessionId: string, fileId: string): Promise<void>;
}

export function attachmentContentUrl(
  sessionId: string,
  fileRef: string,
  baseUrl = "/dsh-open-file/v1"
): string {
  const query = new URLSearchParams({ sessionId, fileRef });
  return `${baseUrl}/attachments/content?${query.toString()}`;
}

interface ErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

async function responseError(response: Response): Promise<OpenFileError> {
  let payload: ErrorPayload = {};
  try {
    payload = (await response.json()) as ErrorPayload;
  } catch {
    // The status remains useful even when an intermediary replaces the JSON body.
  }
  const code = payload.error?.code;
  const supported = typeof code === "string" && code.startsWith("FILE_");
  return new OpenFileError(
    (supported ? code : "FILE_UPLOAD_INCOMPLETE") as OpenFileErrorCode,
    payload.error?.message ?? `The upload request failed with HTTP ${response.status}.`
  );
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin" });
  } catch (error) {
    if (init.signal?.aborted) {
      throw new OpenFileError("FILE_ABORTED", "The upload was aborted.", undefined, { cause: error });
    }
    throw new OpenFileError("FILE_UPLOAD_INCOMPLETE", "The upload request failed.", undefined, {
      cause: error
    });
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export class BrowserAttachmentUploadApi implements AttachmentUploadApi {
  constructor(private readonly baseUrl = "/dsh-open-file/v1") {}

  prepare(sessionId: string, file: File, signal?: AbortSignal): Promise<PreparedBrowserUpload> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        name: file.name,
        size: file.size,
        declaredType: file.type.length === 0 ? null : file.type
      })
    };
    if (signal !== undefined) init.signal = signal;
    return fetchJson<PreparedBrowserUpload>(`${this.baseUrl}/uploads/prepare`, init);
  }

  upload(
    url: string,
    file: File,
    onProgress: (loaded: number, total: number) => void,
    signal: AbortSignal
  ): Promise<StreamedBrowserUpload> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      const abort = (): void => request.abort();
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      request.open("PUT", url, true);
      request.withCredentials = true;
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.responseType = "json";
      request.upload.onprogress = (event) => onProgress(event.loaded, event.total || file.size);
      request.onload = () => {
        cleanup();
        if (request.status >= 200 && request.status < 300) {
          resolve(request.response as StreamedBrowserUpload);
          return;
        }
        const payload = request.response as ErrorPayload | null;
        const code = payload?.error?.code;
        reject(
          new OpenFileError(
            (typeof code === "string" && code.startsWith("FILE_")
              ? code
              : "FILE_UPLOAD_INCOMPLETE") as OpenFileErrorCode,
            payload?.error?.message ?? `The upload stream failed with HTTP ${request.status}.`
          )
        );
      };
      request.onerror = () => {
        cleanup();
        reject(new OpenFileError("FILE_UPLOAD_INCOMPLETE", "The upload stream failed."));
      };
      request.onabort = () => {
        cleanup();
        reject(new OpenFileError("FILE_ABORTED", "The upload was aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        request.abort();
        return;
      }
      request.send(file);
    });
  }

  commit(
    url: string,
    sessionId: string,
    _prepared: PreparedBrowserUpload,
    streamed: StreamedBrowserUpload,
    signal?: AbortSignal
  ): Promise<ReadyBrowserAttachment> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, expectedSha256: streamed.sourceSha256 })
    };
    if (signal !== undefined) init.signal = signal;
    return fetchJson<ReadyBrowserAttachment>(url, init);
  }

  async cancel(url: string): Promise<void> {
    await fetchJson<void>(url, { method: "DELETE" });
  }

  async adopt(sessionId: string, fileId: string): Promise<void> {
    await fetchJson<void>(
      `${this.baseUrl}/attachments/${encodeURIComponent(fileId)}/adopt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      }
    );
  }

  resolve(sessionId: string, fileRef: string): Promise<ResolvedBrowserAttachment> {
    return fetchJson<ResolvedBrowserAttachment>(`${this.baseUrl}/attachments/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, fileRef })
    });
  }
}
