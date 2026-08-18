import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";

import dropFileIllustration from "../../assets/drop-file-illustration.png";
import { DEFAULT_LIMITS } from "../contracts.js";
import { FileBadge } from "./file-badge.js";
import { attachmentContentUrl } from "./api.js";
import { TrashOutline16 } from "./icons.js";
import type { AttachmentDraft, AttachmentQueue } from "./queue.js";

export interface AttachmentDockProps {
  readonly queue: AttachmentQueue;
  readonly sessionId: string;
  readonly locale: string;
  readonly onFiles: (files: Iterable<File>) => void;
}

interface Copy {
  readonly title: string;
  readonly dropTitle: string;
  readonly dropDesc: string;
  readonly waiting: string;
  readonly uploading: string;
  readonly ready: string;
  readonly cancel: string;
  readonly retry: string;
  readonly remove: string;
  readonly open: string;
}

const ZH: Copy = Object.freeze({
  title: "附件草稿",
  dropTitle: "任意文件拖动到此处即可添加",
  dropDesc: `最多 ${DEFAULT_LIMITS.maxDraftFiles} 份，每份 ${DEFAULT_LIMITS.maxFileBytes / (1024 * 1024)}MB`,
  waiting: "等待上传",
  uploading: "正在上传",
  ready: "已就绪",
  cancel: "取消",
  retry: "重试",
  remove: "移除",
  open: "打开"
});

const EN: Copy = Object.freeze({
  title: "Attachment drafts",
  dropTitle: "Drag any files here to add them",
  dropDesc: `Up to ${DEFAULT_LIMITS.maxDraftFiles} files, ${DEFAULT_LIMITS.maxFileBytes / (1024 * 1024)}MB each`,
  waiting: "Waiting",
  uploading: "Uploading",
  ready: "Ready",
  cancel: "Cancel",
  retry: "Retry",
  remove: "Remove",
  open: "Open"
});

const STYLE_ID = "dsh-open-file-client-style";
const CSS = `
.dof-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,24px)*2);max-width:var(--dsh-composer-card-max-width,800px);margin:0 auto 6px;padding:0 var(--dsh-composer-dock-inset,8px);font-family:Inter,var(--dsw-font-family,sans-serif)}
.dof-list{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.dof-card{position:relative;box-sizing:border-box;display:grid;grid-template-columns:30px minmax(0,1fr) auto;grid-template-rows:auto auto;column-gap:8px;align-items:center;min-width:0;width:min(168px,100%);max-width:168px;min-height:46px;flex:0 1 168px;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);padding:5px 6px;box-shadow:0 1px 2px color-mix(in srgb,var(--dsw-alias-label-primary,#222) 5%,transparent)}
.dof-file-badge{position:relative;box-sizing:border-box;grid-column:1;grid-row:1/3;display:grid;place-items:center;width:30px;height:34px;overflow:visible;border:0;border-radius:0;background:transparent;color:#6b7280;line-height:1;text-align:center}
.dof-file-glyph{display:block;width:30px;height:34px;stroke-width:1.65}.dof-file-format-text{font-family:Inter,var(--dsw-font-family,sans-serif)}
.dof-file-badge[data-family="pdf"]{color:#d93d48}.dof-file-badge[data-family="word"]{color:#3478d4}.dof-file-badge[data-family="powerpoint"]{color:#d96b32}.dof-file-badge[data-family="excel"]{color:#278254}.dof-file-badge[data-family="archive"]{color:#a76e10}.dof-file-badge[data-family="tabular"]{color:#167f8a}.dof-file-badge[data-family="text"]{color:#667085}.dof-file-badge[data-family="code"]{color:#5267bd}.dof-file-badge[data-family="markup"]{color:#c4543f}.dof-file-badge[data-family="config"]{color:#78833f}.dof-file-badge[data-family="database"]{color:#7856a8}
.dof-name{overflow:hidden;color:var(--dsw-alias-label-primary,#222);font-size:13px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.dof-meta{color:var(--dsw-alias-label-tertiary,#777);font-size:11px;line-height:16px}
.dof-error{color:var(--dsw-alias-state-error-primary,#b42318)}
.dof-actions{position:relative;z-index:2;grid-column:3;grid-row:1/3;display:flex;flex-direction:column;align-items:flex-end;gap:1px}
.dof-action{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#555);cursor:pointer;padding:3px 5px;font-size:11px;line-height:16px}
.dof-action-icon{box-sizing:border-box;display:grid;place-items:center;width:26px;height:26px;padding:0}
.dof-action:hover,.dof-action:focus-visible{background:var(--dsw-alias-interactive-bg-hover,#eee);outline:none}
.dof-progress{grid-column:2;width:100%;height:3px;margin-top:2px;accent-color:var(--dsw-alias-state-business-primary,#4b6bfb)}
.dof-overlay{position:fixed;z-index:2147483000;inset:0;display:grid;place-items:center;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 84%,transparent);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);color:var(--dsw-alias-label-primary,#222);font-family:var(--dsw-font-family,sans-serif)}
.dof-overlay-content{display:flex;flex-direction:column;align-items:center;text-align:center;transform:translateY(-2vh)}
.dof-overlay-illustration{display:block;width:156px;height:106px;object-fit:cover;object-position:center;margin:0 0 14px}
.dof-overlay-title{font-size:18px;font-weight:600;line-height:26px}
.dof-overlay-desc{margin-top:14px;color:var(--dsw-alias-label-tertiary,#8b8f97);font-size:13px;font-weight:400;line-height:20px}
.dof-user-attachment-group{box-sizing:border-box;display:flex;flex-direction:column;align-items:flex-end;gap:4px;width:100%}
.dof-user-attachment-group>:first-child{align-self:stretch;min-width:0}
.dof-history{box-sizing:border-box;display:grid;justify-items:end;width:min(525px,82%);max-width:100%;gap:4px;margin:0;padding:0;list-style:none}
.dof-history-card{position:relative;box-sizing:border-box;display:grid;grid-template-columns:30px minmax(0,1fr);align-items:center;gap:8px;width:min(192px,100%);max-width:192px;min-height:42px;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#222);padding:4px 6px;font-size:12px}
.dof-open{position:absolute;z-index:1;inset:0;border-radius:inherit;color:inherit;text-decoration:none;cursor:pointer}.dof-open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4b6bfb);outline-offset:2px}.dof-card:has(.dof-open:hover),.dof-history-card:has(.dof-open:hover){background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}
.dof-history-card .dof-file-badge{grid-column:1;grid-row:1;width:28px;height:32px}.dof-history-card .dof-file-glyph{width:28px;height:32px}
.dof-history-copy,.dof-history-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dof-history-card small{display:block;overflow:hidden;color:var(--dsw-alias-label-tertiary,#777);font-size:10px;line-height:14px;text-overflow:ellipsis;white-space:nowrap}
[role="listbox"] [data-source="添加"] + [role="option"] > [aria-hidden="true"],[role="listbox"] [data-source="Add"] + [role="option"] > [aria-hidden="true"]{background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'/%3E%3C/svg%3E") center/contain no-repeat}
`;

export function ensureOpenFileStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function stateLabel(draft: AttachmentDraft, copy: Copy): string {
  if (draft.state === "waiting") return copy.waiting;
  if (draft.state === "uploading") return `${copy.uploading} ${Math.round(draft.progress * 100)}%`;
  if (draft.state === "ready") return copy.ready;
  return draft.errorCode ?? "FILE_UPLOAD_INCOMPLETE";
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

function clipboardFiles(event: ClipboardEvent): readonly File[] {
  const data = event.clipboardData;
  if (data === null) return [];
  const files = Array.from(data.files);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function AttachmentDock({ queue, sessionId, locale, onFiles }: AttachmentDockProps): ReactElement | null {
  ensureOpenFileStyles();
  const copy = locale.toLocaleLowerCase().startsWith("zh") ? ZH : EN;
  const [dragging, setDragging] = useState(false);
  const drafts = useSyncExternalStore(
    (listener) => queue.subscribe(sessionId, listener),
    () => queue.getSnapshot(sessionId),
    () => queue.getSnapshot(sessionId)
  );

  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      depth = 0;
      setDragging(false);
      if (event.dataTransfer !== null) onFiles(event.dataTransfer.files);
    };
    const paste = (event: ClipboardEvent): void => {
      const files = clipboardFiles(event);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onFiles(files);
    };
    document.addEventListener("dragenter", enter, { capture: true });
    document.addEventListener("dragover", over, { capture: true });
    document.addEventListener("dragleave", leave, { capture: true });
    document.addEventListener("drop", drop, { capture: true });
    document.addEventListener("paste", paste, { capture: true });
    return () => {
      document.removeEventListener("dragenter", enter, { capture: true });
      document.removeEventListener("dragover", over, { capture: true });
      document.removeEventListener("dragleave", leave, { capture: true });
      document.removeEventListener("drop", drop, { capture: true });
      document.removeEventListener("paste", paste, { capture: true });
    };
  }, [onFiles]);

  if (drafts.length === 0 && !dragging) return null;
  return (
    <>
      {dragging ? (
        <div className="dof-overlay" role="status" aria-live="polite">
          <div className="dof-overlay-content">
            <img className="dof-overlay-illustration" src={dropFileIllustration} alt="" aria-hidden="true" />
            <strong className="dof-overlay-title">{copy.dropTitle}</strong>
            <small className="dof-overlay-desc">{copy.dropDesc}</small>
          </div>
        </div>
      ) : null}
      {drafts.length > 0 ? (
        <section className="dof-dock" aria-label={copy.title}>
          <ul className="dof-list">
            {drafts.map((draft) => (
              <li className="dof-card" key={draft.id}>
                {draft.state === "ready" && draft.fileRef !== undefined ? (
                  <a
                    className="dof-open"
                    href={attachmentContentUrl(sessionId, draft.fileRef)}
                    target="_blank"
                    rel="noopener"
                    aria-label={`${copy.open} ${draft.displayName}`}
                  />
                ) : null}
                <FileBadge displayName={draft.displayName} detectedType={draft.detectedType} />
                <span className="dof-name" title={draft.displayName}>{draft.displayName}</span>
                <span className={`dof-meta${draft.state === "failed" ? " dof-error" : ""}`}>
                  {formatSize(draft.size)} · {stateLabel(draft, copy)}
                </span>
                {draft.state === "uploading" ? (
                  <progress
                    className="dof-progress"
                    aria-label={`${copy.uploading} ${draft.displayName}`}
                    max={1}
                    value={draft.progress}
                  />
                ) : null}
                <span className="dof-actions">
                  {draft.state === "waiting" || draft.state === "uploading" ? (
                    <button
                      className="dof-action"
                      type="button"
                      aria-label={`${copy.cancel} ${draft.displayName}`}
                      onClick={() => void queue.cancel(sessionId, draft.id)}
                    >{copy.cancel}</button>
                  ) : null}
                  {draft.state === "failed" ? (
                    <button
                      className="dof-action"
                      type="button"
                      aria-label={`${copy.retry} ${draft.displayName}`}
                      onClick={() => queue.retry(sessionId, draft.id)}
                    >{copy.retry}</button>
                  ) : null}
                  <button
                    className="dof-action dof-action-icon"
                    type="button"
                    aria-label={`${copy.remove} ${draft.displayName}`}
                    onClick={() => void queue.remove(sessionId, draft.id)}
                  ><TrashOutline16 /></button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
