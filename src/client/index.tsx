import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { useCallback, useEffect, useSyncExternalStore, type ReactElement } from "react";

import { addAttachmentSourceName, installAddAttachmentSource } from "./add-source.js";
import { BrowserAttachmentUploadApi } from "./api.js";
import { FileIntakeCoordinator } from "./file-intake.js";
import {
  installAttachmentHistoryProjection,
  type HistorySlotRegistry
} from "./history.js";
import { FilePickerController } from "./picker.js";
import { createNativeImageSink } from "./native-images.js";
import { installPlusMenuGroupAdapter } from "./plus-menu-adapter.js";
import { AttachmentQueue } from "./queue.js";
import { installAttachmentSubmitAdapter } from "./submit-adapter.js";
import { AttachmentDock } from "./ui.js";

export const inject = ["slots", "inputTriggers", "conversation", "locale"] as const;

interface DockEntryProps {
  readonly sessionId: string;
  readonly inputActions: unknown;
}

export function apply(context: ClientContext): void {
  context.effect(() => {
    const api = new BrowserAttachmentUploadApi();
    const queue = new AttachmentQueue(api);
    const intake = new FileIntakeCoordinator(queue);
    const picker = new FilePickerController(intake);
    const disposers: Array<() => void> = [
      () => picker.dispose(),
      () => queue.dispose()
    ];
    try {
      let activeLocale = context.locale.getLocale().active;
      let unregisterAddSource = installAddAttachmentSource(context.inputTriggers, {
        locale: activeLocale,
        openPicker: (sessionId) => picker.open(sessionId)
      });
      const unsubscribeLocale = context.locale.subscribe(() => {
        const nextLocale = context.locale.getLocale().active;
        if (nextLocale === activeLocale) return;
        unregisterAddSource();
        activeLocale = nextLocale;
        unregisterAddSource = installAddAttachmentSource(context.inputTriggers, {
          locale: activeLocale,
          openPicker: (sessionId) => picker.open(sessionId)
        });
      });
      disposers.push(() => {
        unsubscribeLocale();
        unregisterAddSource();
      });
      disposers.push(installPlusMenuGroupAdapter(context.inputTriggers, {
        attachmentSourceName: () => addAttachmentSourceName(activeLocale),
      }));
      disposers.push(installAttachmentSubmitAdapter(context.conversation, queue));

      function DockEntry({ sessionId, inputActions }: DockEntryProps): ReactElement | null {
        useEffect(
          () => intake.registerNativeImageSink(
            sessionId,
            createNativeImageSink(context.conversation, inputActions),
          ),
          [sessionId, inputActions],
        );
        const onFiles = useCallback(
          (files: Iterable<File>) => intake.accept(sessionId, files),
          [sessionId],
        );
        const locale = useSyncExternalStore(
          (listener) => context.locale.subscribe(listener),
          () => context.locale.getSnapshot(),
          () => context.locale.getSnapshot()
        ).active;
        return (
          <AttachmentDock
            queue={queue}
            sessionId={sessionId}
            locale={locale}
            onFiles={onFiles}
          />
        );
      }

      disposers.push(
        context.slots.inject("conversation.input.dock", () =>
          context.slots.register(
            {
              name: "conversation.input.dock",
              id: "dsh-open-file.attachments",
              order: 15,
              registrant: "dsh-open-file"
            },
            DockEntry
          )
        )
      );
      disposers.push(
        installAttachmentHistoryProjection(
          context.slots as unknown as HistorySlotRegistry,
          (sessionId, fileRef) => api.resolve(sessionId, fileRef)
        )
      );
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }, "dsh-open-file.client");
}
