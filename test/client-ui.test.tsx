// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AttachmentUploadApi } from "../src/client/api.js";
import { FileIntakeCoordinator } from "../src/client/file-intake.js";
import { FilePickerController } from "../src/client/picker.js";
import { AttachmentQueue } from "../src/client/queue.js";
import { AttachmentDock, ensureOpenFileStyles } from "../src/client/ui.js";

function file(name: string, value = "data"): File {
  return new File([value], name, { type: "application/octet-stream" });
}

function api(): AttachmentUploadApi {
  let sequence = 0;
  return {
    prepare: vi.fn(async (_sessionId, selected) => {
      sequence += 1;
      return {
        uploadId: `upload-${sequence}`,
        fileId: `file-${sequence}`,
        size: selected.size,
        putUrl: `/put/${sequence}`,
        commitUrl: `/commit/${sequence}`,
        deleteUrl: `/delete/${sequence}`
      };
    }),
    upload: vi.fn(async (_url, selected, progress) => {
      progress(selected.size, selected.size);
      return { received: selected.size, sourceSha256: "a".repeat(64) };
    }),
    commit: vi.fn(async (_url, sessionId, prepared, streamed) => ({
      fileRef: `dsh-open-file://attachment/v1/${sessionId}/${prepared.fileId}`,
      fileId: prepared.fileId,
      displayName: `safe-${prepared.fileId}`,
      detectedType: "text/plain",
      size: prepared.size,
      sourceSha256: streamed.sourceSha256,
      draft: true
    })),
    cancel: vi.fn(() => Promise.resolve()),
    adopt: vi.fn(() => Promise.resolve())
  };
}

describe("attachment picker and dock", () => {
  it("provides a paperclip SVG mask for the rc.6 attachment candidate icon slot", () => {
    ensureOpenFileStyles();
    const rules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    const paperclip = rules.find((rule) =>
      rule.selectorText.includes('[data-source="添加"]') &&
      rule.selectorText.includes('[data-source="Add"]'),
    );

    expect(paperclip).toBeDefined();
    expect(paperclip?.style.mask).toContain("data:image/svg+xml");
    expect(paperclip?.style.getPropertyValue("-webkit-mask")).toContain("data:image/svg+xml");
  });

  it("opens one owned multi-file system picker without an accept restriction", () => {
    const queue = new AttachmentQueue(api());
    const picker = new FilePickerController(new FileIntakeCoordinator(queue), document);
    const input = document.querySelector<HTMLInputElement>("input[data-dsh-open-file-picker]");
    expect(input).not.toBeNull();
    expect(input?.multiple).toBe(true);
    expect(input?.getAttribute("accept")).toBeNull();
    const click = vi.spyOn(input as HTMLInputElement, "click").mockImplementation(() => undefined);
    picker.open("session-a");
    expect(click).toHaveBeenCalledOnce();
    Object.defineProperty(input, "files", { configurable: true, value: [file("a"), file("b")] });
    fireEvent.change(input as HTMLInputElement);
    expect(queue.getSnapshot("session-a").map((draft) => draft.displayName)).toEqual(["a", "b"]);
    picker.dispose();
    expect(document.querySelector("input[data-dsh-open-file-picker]")).toBeNull();
  });

  it("shows the illustrated file-drop invitation and uses the same session queue", async () => {
    const queue = new AttachmentQueue(api());
    const intake = new FileIntakeCoordinator(queue);
    const accept = vi.spyOn(intake, "accept");
    render(
      <AttachmentDock
        queue={queue}
        sessionId="session-a"
        locale="zh-CN"
        onFiles={(files) => intake.accept("session-a", files)}
      />,
    );
    fireEvent.dragEnter(document, {
      dataTransfer: { types: ["Files"], files: [file("dropped.txt")] }
    });
    expect(await screen.findByText("任意文件拖动到此处即可添加")).not.toBeNull();
    expect(screen.getByText("最多 20 份，每份 256MB")).not.toBeNull();
    const illustration = document.querySelector<HTMLImageElement>(".dof-overlay-illustration");
    expect(illustration).not.toBeNull();
    expect(illustration?.getAttribute("src")).toMatch(/(?:data:image\/png|drop-file-illustration)/u);
    expect(getComputedStyle(illustration as Element).objectFit).toBe("cover");
    fireEvent.drop(document, {
      dataTransfer: { types: ["Files"], files: [file("dropped.txt")] }
    });
    await waitFor(() => expect(screen.queryByText("dropped.txt")).not.toBeNull());
    expect(accept).toHaveBeenCalledOnce();
    expect(queue.getSnapshot("session-a")).toHaveLength(1);
  });

  it("shows progress state and accessible cancel, retry, and remove controls", async () => {
    let rejectUpload: ((error: unknown) => void) | undefined;
    const backend = api();
    backend.upload = vi.fn<AttachmentUploadApi["upload"]>(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        })
    );
    const queue = new AttachmentQueue(backend);
    render(
      <AttachmentDock
        queue={queue}
        sessionId="session-a"
        locale="en-US"
        onFiles={() => undefined}
      />,
    );
    const [id] = queue.enqueue("session-a", [file("report.pdf")]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel report.pdf" })).not.toBeNull());
    expect(screen.getByLabelText("PDF file")).not.toBeNull();
    expect(document.querySelector(".dof-panel")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Attachment drafts" })).toBeNull();
    rejectUpload?.(new Error("offline"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry report.pdf" })).not.toBeNull());
    expect(screen.queryByText(/FILE_UPLOAD_INCOMPLETE/u)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Remove report.pdf" })).not.toBeNull();
    expect(id).toBeDefined();
  });

  it("keeps a ready draft compact and uses an icon-only remove action", async () => {
    const queue = new AttachmentQueue(api());
    render(
      <AttachmentDock
        queue={queue}
        sessionId="session-a"
        locale="zh-CN"
        onFiles={() => undefined}
      />,
    );
    queue.enqueue("session-a", [file("report.pdf")]);

    const remove = await screen.findByRole("button", { name: "移除 report.pdf" });
    const open = screen.getByRole("link", { name: "打开 report.pdf" });
    const card = remove.closest(".dof-card");
    expect(remove.querySelector("svg path")?.getAttribute("d")).toContain("M14.4782 4.84067");
    expect(remove.textContent).toBe("");
    expect(card).not.toBeNull();
    expect(getComputedStyle(card as Element).flexGrow).toBe("0");
    expect(getComputedStyle(card as Element).maxWidth).toBe("168px");
    expect(open.getAttribute("href")).toContain("/dsh-open-file/v1/attachments/content?");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener");
  });
});
