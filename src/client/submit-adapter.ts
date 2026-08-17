import { OpenFileError } from "../errors.js";
import { canonicalService } from "./canonical.js";

const ADAPTER = Symbol.for("dsh-open-file.rc6.submit-adapter");

export interface ReadyAttachment {
  readonly fileRef: string;
  readonly fileId: string;
  readonly displayName: string;
}

export interface SubmitAttachmentQueue {
  hasDrafts(sessionId: string): boolean;
  waitUntilReady(sessionId: string): Promise<readonly ReadyAttachment[]>;
  adoptAndClear(sessionId: string): Promise<void>;
}

type SendSession = (
  session: { readonly sessionId: string },
  text: string,
  imageIds: readonly unknown[],
  mode: unknown
) => Promise<void>;

interface ConversationShape {
  sendSession: SendSession;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]").replace(/[\r\n]+/gu, " ");
}

export function appendAttachmentLinks(
  text: string,
  attachments: readonly ReadyAttachment[]
): string {
  const links = attachments
    .map((attachment) => `[Attached file: ${escapeLabel(attachment.displayName)}](${attachment.fileRef})`)
    .join("\n");
  if (links.length === 0) return text;
  return text.length === 0 ? links : `${text}\n\n${links}`;
}

export function installAttachmentSubmitAdapter(
  service: unknown,
  queue: SubmitAttachmentQueue
): () => void {
  const canonical = canonicalService(service) as Record<PropertyKey, unknown>;
  if (typeof canonical.sendSession !== "function") {
    throw new OpenFileError(
      "FILE_WEB_COMPATIBILITY",
      "DSH rc.6 conversation submission does not match the supported contract."
    );
  }
  if (canonical[ADAPTER] !== undefined) {
    throw new OpenFileError("FILE_WEB_COMPATIBILITY", "The attachment submit adapter is already installed.");
  }
  const conversation = canonical as unknown as ConversationShape;
  const original = conversation.sendSession;
  const wrapped: SendSession = async (session, text, imageIds, mode) => {
    const sessionId = String(session.sessionId);
    if (!queue.hasDrafts(sessionId)) {
      await original.call(conversation, session, text, imageIds, mode);
      return;
    }
    const attachments = await queue.waitUntilReady(sessionId);
    await original.call(
      conversation,
      session,
      appendAttachmentLinks(text, attachments),
      imageIds,
      mode
    );
    await queue.adoptAndClear(sessionId);
  };
  canonical[ADAPTER] = Object.freeze({ wrapped });
  conversation.sendSession = wrapped;
  return () => {
    if (conversation.sendSession === wrapped) conversation.sendSession = original;
    if (canonical[ADAPTER] !== undefined) delete canonical[ADAPTER];
  };
}
