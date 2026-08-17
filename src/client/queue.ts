import { DEFAULT_LIMITS } from "../contracts.js";
import { OpenFileError } from "../errors.js";
import type {
  AttachmentUploadApi,
  PreparedBrowserUpload,
  ReadyBrowserAttachment
} from "./api.js";
import type { ReadyAttachment, SubmitAttachmentQueue } from "./submit-adapter.js";

export type AttachmentDraftState = "waiting" | "uploading" | "ready" | "failed";

export interface AttachmentDraft {
  readonly id: string;
  readonly displayName: string;
  readonly size: number;
  readonly state: AttachmentDraftState;
  readonly progress: number;
  readonly detectedType?: string;
  readonly fileRef?: string;
  readonly errorCode?: string;
}

interface MutableDraft {
  readonly id: string;
  readonly file: File;
  readonly displayName: string;
  readonly size: number;
  state: AttachmentDraftState;
  progress: number;
  detectedType: string | undefined;
  errorCode: string | undefined;
  prepared: PreparedBrowserUpload | undefined;
  ready: ReadyBrowserAttachment | undefined;
  controller: AbortController | undefined;
  cancelled: boolean;
}

interface SessionQueue {
  readonly drafts: MutableDraft[];
  readonly listeners: Set<() => void>;
  snapshot: readonly AttachmentDraft[];
}

export interface AttachmentQueueOptions {
  readonly concurrency?: number;
  readonly maxDraftFiles?: number;
  readonly maxDraftBytes?: number;
}

export class AttachmentQueueError extends Error {
  override readonly name = "AttachmentQueueError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof OpenFileError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "FILE_ABORTED";
  return "FILE_UPLOAD_INCOMPLETE";
}

function publicDraft(draft: MutableDraft): AttachmentDraft {
  const result: {
    id: string;
    displayName: string;
    size: number;
    state: AttachmentDraftState;
    progress: number;
    detectedType?: string;
    fileRef?: string;
    errorCode?: string;
  } = {
    id: draft.id,
    displayName: draft.displayName,
    size: draft.size,
    state: draft.state,
    progress: draft.progress
  };
  if (draft.detectedType !== undefined) result.detectedType = draft.detectedType;
  if (draft.ready !== undefined) result.fileRef = draft.ready.fileRef;
  if (draft.errorCode !== undefined) result.errorCode = draft.errorCode;
  return Object.freeze(result);
}

export class AttachmentQueue implements SubmitAttachmentQueue {
  private readonly sessions = new Map<string, SessionQueue>();
  private readonly concurrency: number;
  private readonly maxDraftFiles: number;
  private readonly maxDraftBytes: number;
  private running = 0;
  private sequence = 0;
  private pumpScheduled = false;

  constructor(
    private readonly api: AttachmentUploadApi,
    options: AttachmentQueueOptions = {}
  ) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 3));
    this.maxDraftFiles = options.maxDraftFiles ?? DEFAULT_LIMITS.maxDraftFiles;
    this.maxDraftBytes = options.maxDraftBytes ?? DEFAULT_LIMITS.maxDraftBytes;
  }

  enqueue(sessionId: string, files: Iterable<File>): readonly string[] {
    const session = this.session(sessionId);
    const ids: string[] = [];
    let acceptedCount = session.drafts.filter((draft) => draft.errorCode !== "FILE_UPLOAD_TOO_LARGE").length;
    let acceptedBytes = session.drafts
      .filter((draft) => draft.errorCode !== "FILE_UPLOAD_TOO_LARGE")
      .reduce((total, draft) => total + draft.size, 0);
    for (const file of files) {
      const id = `attachment-${++this.sequence}`;
      ids.push(id);
      const exceeds = acceptedCount >= this.maxDraftFiles || acceptedBytes + file.size > this.maxDraftBytes;
      const draft: MutableDraft = {
        id,
        file,
        displayName: file.name,
        size: file.size,
        state: exceeds ? "failed" : "waiting",
        progress: 0,
        detectedType: undefined,
        errorCode: undefined,
        prepared: undefined,
        ready: undefined,
        controller: undefined,
        cancelled: false
      };
      if (exceeds) draft.errorCode = "FILE_UPLOAD_TOO_LARGE";
      else {
        acceptedCount += 1;
        acceptedBytes += file.size;
      }
      session.drafts.push(draft);
    }
    this.publish(session);
    this.schedulePump();
    return Object.freeze(ids);
  }

  getSnapshot(sessionId: string): readonly AttachmentDraft[] {
    return this.session(sessionId).snapshot;
  }

  subscribe(sessionId: string, listener: () => void): () => void {
    const listeners = this.session(sessionId).listeners;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  hasDrafts(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.drafts.length ?? 0) > 0;
  }

  async waitUntilReady(sessionId: string): Promise<readonly ReadyAttachment[]> {
    const session = this.session(sessionId);
    while (true) {
      const failed = session.drafts.find((draft) => draft.state === "failed");
      if (failed !== undefined) {
        throw new AttachmentQueueError(
          failed.errorCode ?? "FILE_UPLOAD_INCOMPLETE",
          `Attachment upload failed: ${failed.displayName}`
        );
      }
      if (session.drafts.every((draft) => draft.state === "ready")) {
        return Object.freeze(
          session.drafts.map((draft) => {
            if (draft.ready === undefined) {
              throw new AttachmentQueueError("FILE_INTERNAL", "A ready attachment is missing metadata.");
            }
            return Object.freeze({
              fileRef: draft.ready.fileRef,
              fileId: draft.ready.fileId,
              displayName: draft.displayName
            });
          })
        );
      }
      await new Promise<void>((resolve) => {
        const unsubscribe = this.subscribe(sessionId, () => {
          unsubscribe();
          resolve();
        });
      });
    }
  }

  async cancel(sessionId: string, id: string): Promise<void> {
    const session = this.session(sessionId);
    const draft = session.drafts.find((candidate) => candidate.id === id);
    if (draft === undefined) return;
    draft.cancelled = true;
    draft.controller?.abort();
    if (draft.prepared !== undefined) await this.api.cancel(draft.prepared.deleteUrl).catch(() => undefined);
    draft.controller = undefined;
    draft.state = "failed";
    draft.errorCode = "FILE_ABORTED";
    this.publish(session);
  }

  retry(sessionId: string, id: string): void {
    const session = this.session(sessionId);
    const draft = session.drafts.find((candidate) => candidate.id === id);
    if (draft === undefined || draft.state !== "failed") return;
    draft.cancelled = false;
    draft.prepared = undefined;
    draft.ready = undefined;
    draft.detectedType = undefined;
    draft.errorCode = undefined;
    draft.progress = 0;
    draft.state = "waiting";
    this.publish(session);
    this.schedulePump();
  }

  async remove(sessionId: string, id: string): Promise<void> {
    const session = this.session(sessionId);
    const index = session.drafts.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    const draft = session.drafts[index];
    if (draft === undefined) return;
    draft.cancelled = true;
    draft.controller?.abort();
    if (draft.prepared !== undefined) await this.api.cancel(draft.prepared.deleteUrl).catch(() => undefined);
    session.drafts.splice(index, 1);
    this.publish(session);
    this.schedulePump();
  }

  async adoptAndClear(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    for (const draft of session.drafts) {
      if (draft.ready === undefined) {
        throw new AttachmentQueueError("FILE_UPLOAD_INCOMPLETE", "An attachment is not ready.");
      }
      await this.api.adopt(sessionId, draft.ready.fileId);
    }
    session.drafts.splice(0);
    this.publish(session);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      for (const draft of session.drafts) draft.controller?.abort();
      session.listeners.clear();
    }
    this.sessions.clear();
  }

  private session(sessionId: string): SessionQueue {
    let session = this.sessions.get(sessionId);
    if (session === undefined) {
      session = { drafts: [], listeners: new Set(), snapshot: Object.freeze([]) };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private publish(session: SessionQueue): void {
    session.snapshot = Object.freeze(session.drafts.map(publicDraft));
    for (const listener of session.listeners) listener();
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      let next: { session: SessionQueue; draft: MutableDraft } | undefined;
      for (const session of this.sessions.values()) {
        const draft = session.drafts.find((candidate) => candidate.state === "waiting");
        if (draft !== undefined) {
          next = { session, draft };
          break;
        }
      }
      if (next === undefined) return;
      this.running += 1;
      next.draft.state = "uploading";
      next.draft.progress = 0;
      this.publish(next.session);
      void this.run(next.session, next.draft).finally(() => {
        this.running -= 1;
        this.schedulePump();
      });
    }
  }

  private async run(session: SessionQueue, draft: MutableDraft): Promise<void> {
    const sessionId = [...this.sessions].find(([, candidate]) => candidate === session)?.[0];
    if (sessionId === undefined) return;
    const controller = new AbortController();
    draft.controller = controller;
    try {
      const prepared = await this.api.prepare(sessionId, draft.file, controller.signal);
      draft.prepared = prepared;
      if (draft.cancelled) throw new OpenFileError("FILE_ABORTED", "The upload was aborted.");
      const streamed = await this.api.upload(
        prepared.putUrl,
        draft.file,
        (loaded, total) => {
          if (draft.state !== "uploading") return;
          draft.progress = total <= 0 ? 0 : Math.max(0, Math.min(1, loaded / total));
          this.publish(session);
        },
        controller.signal
      );
      if (draft.cancelled) throw new OpenFileError("FILE_ABORTED", "The upload was aborted.");
      const ready = await this.api.commit(
        prepared.commitUrl,
        sessionId,
        prepared,
        streamed,
        controller.signal
      );
      if (draft.cancelled) throw new OpenFileError("FILE_ABORTED", "The upload was aborted.");
      draft.ready = ready;
      draft.detectedType = ready.detectedType;
      draft.progress = 1;
      draft.state = "ready";
      draft.errorCode = undefined;
    } catch (error) {
      draft.state = "failed";
      draft.errorCode = draft.cancelled ? "FILE_ABORTED" : errorCode(error);
    } finally {
      draft.controller = undefined;
      this.publish(session);
    }
  }
}
