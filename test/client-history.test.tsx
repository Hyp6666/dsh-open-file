// @vitest-environment jsdom

import { render, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  installAttachmentHistoryProjection,
  projectAttachmentLinks
} from "../src/client/history.js";

const firstRef =
  "dsh-open-file://attachment/v1/session-a/018f3f08-a9d1-7d01-9128-112233445566";

describe("historical attachment projection", () => {
  it("removes only canonical generated link lines from the display projection", () => {
    const content = [
      {
        type: "text" as const,
        text: `Question\n\n[Attached file: report\\].pdf](${firstRef})\nnot [Attached file: inline](${firstRef})`
      }
    ];
    const projected = projectAttachmentLinks(content);
    expect(projected.attachments).toEqual([{ displayName: "report].pdf", fileRef: firstRef }]);
    expect(projected.content).toEqual([
      { type: "text", text: `Question\n\nnot [Attached file: inline](${firstRef})` }
    ]);
    expect(content[0]?.text).toContain("[Attached file:");
  });

  it("does not recognize or rewrite visual-plugin and native image references", () => {
    const text = [
      "Look at these images",
      "[Vision image](dsh-open-eyes://attachment/v1/session-a/image-a)",
      "[Native image](dsh://attachments/v1/image-b)",
    ].join("\n");
    expect(projectAttachmentLinks([{ type: "text", text }])).toEqual({
      content: [{ type: "text", text }],
      attachments: [],
    });
  });

  it("shadows only stock user and steering cells and restores on dispose", async () => {
    const Stock = ({ node }: { node: { data: { content: readonly unknown[] } } }) => (
      <div data-testid="stock">{JSON.stringify(node.data.content)}</div>
    );
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
    const removed = vi.fn();
    const slots = {
      entries: () => [
        { component: Stock, options: { key: "user", priority: 0 }, registrant: "stock" },
        { component: Stock, options: { key: "steering", priority: 0 }, registrant: "stock" }
      ],
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component });
        return removed;
      }
    };
    const resolve = vi.fn(() => Promise.resolve({
      displayName: "report.pdf",
      detectedType: "application/pdf",
      size: 2048,
    }));
    const dispose = installAttachmentHistoryProjection(slots, resolve);
    expect(registrations.map(({ options }) => options)).toMatchObject([
      { name: "conversation.chat.node", key: "user", priority: -10 },
      { name: "conversation.chat.node", key: "steering", priority: -10 }
    ]);
    for (const [index, kind] of ["user", "steering"].entries()) {
      const Projected = registrations[index]?.component as ComponentType<{
        sessionId: string;
        node: { kind: string; data: { content: readonly { type: string; text: string }[] } };
      }>;
      const view = render(
        <Projected
          sessionId="session-a"
          node={{ kind, data: { content: [{ type: "text", text: `[Attached file: report.pdf](${firstRef})` }] } }}
        />
      );
      expect(await within(view.container).findByLabelText("PDF file")).not.toBeNull();
      const group = view.container.querySelector(".dof-user-attachment-group");
      const stock = view.container.querySelector("[data-testid='stock']");
      const attachments = view.container.querySelector("[aria-label='Attachments']");
      const open = within(view.container).getByRole("link", { name: "Open report.pdf" });
      expect(group).not.toBeNull();
      expect(group?.firstElementChild).toBe(stock);
      expect(group?.contains(attachments)).toBe(true);
      expect(getComputedStyle(group as Element).alignItems).toBe("flex-end");
      expect(getComputedStyle(stock as Element).alignSelf).toBe("stretch");
      expect(getComputedStyle(attachments?.firstElementChild as Element).maxWidth).toBe("192px");
      expect(open.getAttribute("href")).toContain("/dsh-open-file/v1/attachments/content?");
      expect(open.getAttribute("target")).toBe("_blank");
      expect(open.getAttribute("rel")).toBe("noopener");
      expect(stock?.textContent).not.toContain("Attached file");
      view.unmount();
    }
    dispose();
    expect(removed).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the rc.6 stock cell is missing or ambiguous", () => {
    const slots = {
      entries: () => [],
      inject: (_name: string, callback: () => () => void) => callback(),
      register: () => () => undefined
    };
    expect(() => installAttachmentHistoryProjection(slots)).toThrowError(
      expect.objectContaining({ code: "FILE_WEB_COMPATIBILITY" })
    );
  });
});
