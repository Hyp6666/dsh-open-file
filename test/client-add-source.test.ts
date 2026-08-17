import type {
  CandidateRequest,
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { describe, expect, it, vi } from "vitest";

import { installAddAttachmentSource } from "../src/client/add-source.js";

function request(query = ""): CandidateRequest {
  return {
    query,
    position: "leading",
    signal: new AbortController().signal
  };
}

function session(): ClientSessionContext {
  return { sessionId: "session-a" as ClientSessionContext["sessionId"] };
}

function pick(candidate: InputTriggerCandidate): InputTriggerPick {
  return {
    candidate,
    session: session(),
    position: "leading",
    via: "menu",
    span: { start: 0, end: 0, draftRev: 1 }
  };
}

describe("Add attachment input source", () => {
  it("registers an independent Chinese Add group with an SVG-ready paperclip slot", async () => {
    let source: InputTriggerSource | undefined;
    const unregister = vi.fn();
    const dispose = installAddAttachmentSource(
      {
        registerSource(value) {
          source = value;
          return unregister;
        }
      },
      { locale: "zh-CN", openPicker: vi.fn() }
    );

    expect(source).toMatchObject({ trigger: "/", name: "添加", order: 10 });
    const rows = await source!.candidates(session(), request());
    expect(rows).toEqual([
      { name: "附件", description: "从本机选择一个或多个文件", icon: "" }
    ]);

    dispose();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("filters its own English row and opens only for the candidate identity it created", async () => {
    let source: InputTriggerSource | undefined;
    const openPicker = vi.fn();
    installAddAttachmentSource(
      {
        registerSource(value) {
          source = value;
          return () => undefined;
        }
      },
      { locale: "en-US", openPicker }
    );

    expect(source?.name).toBe("Add");
    expect(await source!.candidates(session(), request("missing"))).toEqual([]);
    const rows = await source!.candidates(session(), request("attachment"));
    expect(rows).toEqual([
      {
        name: "Attachment",
        description: "Choose one or more files from this device",
        icon: ""
      }
    ]);
    expect(source!.onPick(pick({ ...rows[0]! }))).toBeUndefined();
    expect(openPicker).not.toHaveBeenCalled();
    expect(source!.onPick(pick(rows[0]!))).toBe("handled");
    expect(openPicker).toHaveBeenCalledWith("session-a");
  });
});
