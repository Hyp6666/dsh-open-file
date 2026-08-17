// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";

import { apply } from "../src/client/index.js";

describe("rc.6 client composition", () => {
  it("registers the Add source and attachment dock, then disposes exactly", async () => {
    const sources: Array<Record<string, unknown>> = [];
    const unregisterSource = vi.fn();
    const registerSource = vi.fn((source: Record<string, unknown>) => {
      sources.push(source);
      return unregisterSource;
    });
    const originalSessionOf = vi.fn();
    const inputTriggers = {
      registerSource,
      live: { controllers: new Map() },
      sessionOf: originalSessionOf,
    };
    const originalSend = vi.fn(() => Promise.resolve());
    const nativeDrafts = [{ id: "native-draft-a" }];
    const createDraftImages = vi.fn(() => nativeDrafts);
    const releaseDraftImages = vi.fn();
    const conversation = { sendSession: originalSend, createDraftImages, releaseDraftImages };
    const addImages = vi.fn(() => true);
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = [];
    const effects: Array<() => void> = [];
    const localeSnapshot = { active: "en-US", locales: [], revision: 1 };
    const context = {
      inputTriggers,
      conversation,
      locale: {
        getLocale: () => localeSnapshot,
        getSnapshot: () => localeSnapshot,
        subscribe: () => () => undefined
      },
      slots: {
        entries: () => [
          { component: () => null, options: { key: "user", priority: 0 }, registrant: "stock" },
          { component: () => null, options: { key: "steering", priority: 0 }, registrant: "stock" }
        ],
        inject: (_name: string, callback: () => () => void) => callback(),
        register: (options: Record<string, unknown>, value: unknown) => {
          registrations.push({ options, component: value });
          return () => undefined;
        }
      },
      effect: (setup: () => () => void) => {
        effects.push(setup());
      }
    };
    apply(context as never);
    expect(registerSource).toHaveBeenCalledTimes(1);
    expect(inputTriggers.sessionOf).not.toBe(originalSessionOf);
    expect(sources[0]).toMatchObject({ trigger: "/", name: "Add", order: 10 });
    const dock = registrations.find(({ options }) => options.name === "conversation.input.dock");
    expect(dock?.options).toMatchObject({
      name: "conversation.input.dock",
      id: "dsh-open-file.attachments"
    });
    expect(typeof dock?.component).toBe("function");
    expect(registrations.filter(({ options }) => options.name === "conversation.chat.node")).toHaveLength(2);
    expect(conversation.sendSession).not.toBe(originalSend);
    expect(document.querySelector("input[data-dsh-open-file-picker]")).not.toBeNull();

    const mounted = render(
      createElement(dock?.component as ComponentType<Record<string, unknown>>, {
        sessionId: "session-a",
        inputActions: { addImages },
      }),
    );
    const png = new File(["pixels"], "native.png", { type: "image/png" });
    fireEvent.drop(document, { dataTransfer: { types: ["Files"], files: [png] } });
    expect(createDraftImages).toHaveBeenCalledWith([png]);
    expect(addImages).toHaveBeenCalledWith(["native-draft-a"]);
    expect(releaseDraftImages).not.toHaveBeenCalled();

    mounted.unmount();
    for (const dispose of effects.reverse()) dispose();
    expect(unregisterSource).toHaveBeenCalledTimes(1);
    expect(inputTriggers.sessionOf).toBe(originalSessionOf);
    expect(conversation.sendSession).toBe(originalSend);
    expect(document.querySelector("input[data-dsh-open-file-picker]")).toBeNull();
  });
});
