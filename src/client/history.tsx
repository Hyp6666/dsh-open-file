import { createElement, useEffect, useState, type ElementType, type ReactElement } from "react";

import { OpenFileError } from "../errors.js";
import { attachmentContentUrl } from "./api.js";
import { FileBadge } from "./file-badge.js";
import { ensureOpenFileStyles } from "./ui.js";

export interface HistoricalAttachment {
  readonly displayName: string;
  readonly fileRef: string;
}

interface ContentLike {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

export interface AttachmentLinkProjection {
  readonly content: readonly ContentLike[];
  readonly attachments: readonly HistoricalAttachment[];
}

interface StoredHistoryEntry {
  readonly component: unknown;
  readonly options: {
    readonly key?: string;
    readonly priority?: number;
  };
  readonly registrant?: string;
}

export interface HistorySlotRegistry {
  entries(name: string): readonly StoredHistoryEntry[];
  inject(name: "conversation.chat.node", callback: () => () => void): () => void;
  register(options: Record<string, unknown>, component: unknown): () => void;
}

export interface HistoricalAttachmentMetadata {
  readonly displayName: string;
  readonly detectedType: string;
  readonly size: number;
}

export type HistoricalAttachmentResolver = (
  sessionId: string,
  fileRef: string
) => Promise<HistoricalAttachmentMetadata>;

interface HistoryNodeProps {
  readonly node: {
    readonly data: {
      readonly content: readonly ContentLike[];
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

const LINK = /^\[Attached file: ((?:\\.|[^\]])*)\]\((dsh-open-file:\/\/attachment\/v1\/[^()\s]+)\)$/u;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function canonicalRef(value: string): boolean {
  const pieces = value.slice("dsh-open-file://attachment/v1/".length).split("/");
  if (pieces.length !== 2 || !FILE_ID.test(pieces[1] ?? "")) return false;
  try {
    const encoded = pieces[0] ?? "";
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 && encodeURIComponent(decoded) === encoded;
  } catch {
    return false;
  }
}

function unescapeLabel(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}

export function projectAttachmentLinks(content: readonly ContentLike[]): AttachmentLinkProjection {
  const attachments: HistoricalAttachment[] = [];
  const projected: ContentLike[] = [];
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      projected.push(block);
      continue;
    }
    const kept: string[] = [];
    for (const line of block.text.split("\n")) {
      const match = LINK.exec(line);
      const fileRef = match?.[2];
      if (match === null || fileRef === undefined || !canonicalRef(fileRef)) {
        kept.push(line);
        continue;
      }
      attachments.push(Object.freeze({ displayName: unescapeLabel(match[1] ?? ""), fileRef }));
    }
    while (kept.at(-1) === "") kept.pop();
    if (kept.length > 0) projected.push(Object.freeze({ ...block, text: kept.join("\n") }));
  }
  return Object.freeze({
    content: Object.freeze(projected),
    attachments: Object.freeze(attachments)
  });
}

function displayBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function HistoricalAttachmentCards({
  attachments,
  sessionId,
  resolve
}: {
  readonly attachments: readonly HistoricalAttachment[];
  readonly sessionId: string | undefined;
  readonly resolve: HistoricalAttachmentResolver | undefined;
}): ReactElement {
  ensureOpenFileStyles();
  const [metadata, setMetadata] = useState<ReadonlyMap<string, HistoricalAttachmentMetadata>>(
    new Map()
  );
  useEffect(() => {
    if (resolve === undefined || sessionId === undefined) return;
    let active = true;
    void Promise.all(
      attachments.map(async (attachment) => {
        try {
          return [attachment.fileRef, await resolve(sessionId, attachment.fileRef)] as const;
        } catch {
          return undefined;
        }
      })
    ).then((values) => {
      if (!active) return;
      setMetadata(new Map(values.filter((value) => value !== undefined)));
    });
    return () => {
      active = false;
    };
  }, [attachments, resolve, sessionId]);
  return (
    <ul className="dof-history" aria-label="Attachments">
      {attachments.map((attachment) => {
        const resolved = metadata.get(attachment.fileRef);
        return (
          <li className="dof-history-card" key={attachment.fileRef} title={attachment.fileRef}>
            {sessionId === undefined ? null : (
              <a
                className="dof-open"
                href={attachmentContentUrl(sessionId, attachment.fileRef)}
                target="_blank"
                rel="noopener"
                aria-label={`Open ${resolved?.displayName ?? attachment.displayName}`}
              />
            )}
            <FileBadge
              displayName={resolved?.displayName ?? attachment.displayName}
              detectedType={resolved?.detectedType}
            />
            <span className="dof-history-copy">
              <span
                className="dof-history-name"
                title={resolved?.displayName ?? attachment.displayName}
              >
                {resolved?.displayName ?? attachment.displayName}
              </span>
              {resolved === undefined ? null : (
                <small>{resolved.detectedType} · {displayBytes(resolved.size)}</small>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function projectedComponent(
  original: unknown,
  resolve: HistoricalAttachmentResolver | undefined
): (props: HistoryNodeProps) => ReactElement {
  return function AttachmentHistoryProjection(props: HistoryNodeProps): ReactElement {
    const projection = projectAttachmentLinks(props.node.data.content);
    if (projection.attachments.length === 0) {
      return createElement(original as ElementType, props);
    }
    const projectedProps: HistoryNodeProps = {
      ...props,
      node: {
        ...props.node,
        data: { ...props.node.data, content: projection.content }
      }
    };
    return (
      <div className="dof-user-attachment-group">
        {createElement(original as ElementType, projectedProps)}
        <HistoricalAttachmentCards
          attachments={projection.attachments}
          sessionId={typeof props.sessionId === "string" ? props.sessionId : undefined}
          resolve={resolve}
        />
      </div>
    );
  };
}

export function installAttachmentHistoryProjection(
  slots: HistorySlotRegistry,
  resolve?: HistoricalAttachmentResolver
): () => void {
  const disposers: Array<() => void> = [];
  try {
    for (const key of ["user", "steering"] as const) {
      disposers.push(
        slots.inject("conversation.chat.node", () => {
          const candidates = slots
            .entries("conversation.chat.node")
            .filter(
              (entry) =>
                entry.options.key === key &&
                (entry.options.priority ?? 0) >= 0 &&
                entry.registrant !== "dsh-open-file"
            );
          if (candidates.length !== 1 || candidates[0]?.component === undefined) {
            throw new OpenFileError(
              "FILE_WEB_COMPATIBILITY",
              `DSH rc.6 ${key} message renderer does not match the supported contract.`
            );
          }
          return slots.register(
            {
              name: "conversation.chat.node",
              key,
              priority: -10,
              locale: "conversation",
              registrant: "dsh-open-file"
            },
            projectedComponent(candidates[0].component, resolve)
          );
        })
      );
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
