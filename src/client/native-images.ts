import { OpenFileError } from "../errors.js";
import { canonicalService } from "./canonical.js";
import type { NativeImageSink } from "./file-intake.js";

interface NativeDraft {
  readonly id: unknown;
}

interface NativeConversation {
  createDraftImages(files: readonly File[]): readonly NativeDraft[];
  releaseDraftImages(drafts: readonly NativeDraft[]): void;
}

interface NativeInputActions {
  addImages(ids: readonly unknown[]): boolean;
}

export function createNativeImageSink(
  service: unknown,
  inputActionsValue: unknown,
): NativeImageSink {
  const conversation = canonicalService(service) as Partial<NativeConversation>;
  const inputActions = inputActionsValue as Partial<NativeInputActions>;
  if (
    typeof conversation.createDraftImages !== "function" ||
    typeof conversation.releaseDraftImages !== "function" ||
    typeof inputActions.addImages !== "function"
  ) {
    throw new OpenFileError(
      "FILE_WEB_COMPATIBILITY",
      "DSH rc.6 native image draft input does not match the supported contract.",
    );
  }
  const createDraftImages = conversation.createDraftImages;
  const releaseDraftImages = conversation.releaseDraftImages;
  const addImages = inputActions.addImages;

  return Object.freeze({
    add(files: readonly File[]): void {
      const drafts: unknown = createDraftImages.call(conversation, files);
      if (!Array.isArray(drafts)) {
        throw new OpenFileError(
          "FILE_WEB_COMPATIBILITY",
          "DSH rc.6 native image draft creation returned an unsupported value.",
        );
      }
      let accepted = false;
      try {
        accepted = addImages.call(
          inputActions,
          drafts.map((draft: NativeDraft) => draft.id),
        ) === true;
      } finally {
        if (!accepted) releaseDraftImages.call(conversation, drafts as readonly NativeDraft[]);
      }
    },
  });
}
