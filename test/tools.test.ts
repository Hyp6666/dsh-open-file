import { describe, expect, it, vi } from "vitest";

import type { JsonValue, ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";

import { FIXED_TOOL_FOOTER, type ToolEnvelope } from "../src/contracts.js";
import {
  createFileToolDefinitions,
  type FileToolOperations,
  type ToolOperationContext
} from "../src/tools/index.js";

function result(partRef?: string): Omit<ToolEnvelope<{ value: string }>, "note"> {
  return {
    ok: true,
    file_ref: "dsh-open-file://attachment/v1/session-a/018f3f08-a9d1-7d01-9128-112233445566",
    ...(partRef === undefined ? {} : { part_ref: partRef }),
    source_sha256: "a".repeat(64),
    parser: "fixture",
    locator: { kind: "fixture" },
    cursor: null,
    data: { value: "ok" }
  };
}

function operations() {
  return {
    inspect: vi.fn<FileToolOperations["inspect"]>().mockResolvedValue(result()),
    read: vi.fn<FileToolOperations["read"]>().mockResolvedValue(result("part")),
    ocr: vi.fn<FileToolOperations["ocr"]>().mockResolvedValue(result("ocr")),
    render: vi.fn<FileToolOperations["render"]>().mockResolvedValue(result("render"))
  } satisfies FileToolOperations;
}

function execution(): ToolRunContext {
  return {
    callId: "call-1",
    name: "fixture",
    arguments: {},
    signal: new AbortController().signal,
    agent: {
      id: "session-a",
      session: { header: { cwd: "/workspace" } }
    },
    deferContext: () => undefined,
    concludeTurn: () => undefined
  } as unknown as ToolRunContext;
}

function byName(definitions: readonly ToolDefinition[], name: string): ToolDefinition {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`missing tool ${name}`);
  return definition;
}

describe("four independent DSH tools", () => {
  it("registers only the four exact public tool names", () => {
    expect(createFileToolDefinitions(operations()).map((definition) => definition.name)).toEqual([
      "file_inspect",
      "file_read",
      "file_ocr",
      "file_render"
    ]);
  });

  it.each([
    ["file_inspect", "inspect", { file_ref: "attachment" }],
    ["file_read", "read", { file_ref: "attachment", part_ref: "part", max_chars: 20 }],
    ["file_ocr", "ocr", { part_ref: "part", languages: "eng" }],
    ["file_render", "render", { part_ref: "part", scale: 2 }]
  ] as const)("%s invokes only its own operation", async (toolName, operationName, args) => {
    const handlers = operations();
    const definitions = createFileToolDefinitions(handlers);
    const value = await byName(definitions, toolName).execute(args, execution());
    expect(handlers[operationName]).toHaveBeenCalledTimes(1);
    for (const [name, handler] of Object.entries(handlers)) {
      if (name !== operationName) expect(handler).not.toHaveBeenCalled();
    }
    const context = handlers[operationName].mock.calls[0]?.[0] as ToolOperationContext;
    expect(context).toMatchObject({ workspace: "/workspace", sessionId: "session-a" });
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(value).toMatchObject({ note: FIXED_TOOL_FOOTER });
  });

  it("requires an agent-bound absolute workspace", async () => {
    const definition = byName(createFileToolDefinitions(operations()), "file_inspect");
    const withoutAgent = { ...execution(), agent: undefined } as unknown as ToolRunContext;
    await expect(definition.execute({ file_ref: "x" }, withoutAgent)).rejects.toMatchObject({
      code: "FILE_WORKSPACE_UNAVAILABLE"
    });
    const relative = execution();
    Object.defineProperty(relative.agent?.session.header, "cwd", { value: "relative" });
    await expect(definition.execute({ file_ref: "x" }, relative)).rejects.toMatchObject({
      code: "FILE_WORKSPACE_UNAVAILABLE"
    });
  });

  it("declares canonical output schemas and renders the fixed footer", async () => {
    for (const definition of createFileToolDefinitions(operations())) {
      expect(definition.output.schema).toMatchObject({ type: "object", additionalProperties: false });
      const value = (await definition.execute(
        definition.name === "file_ocr" || definition.name === "file_render"
          ? { part_ref: "part", ...(definition.name === "file_ocr" ? { languages: "eng" } : {}) }
          : { file_ref: "attachment", ...(definition.name === "file_read" ? { part_ref: "part" } : {}) },
        execution()
      )) as ToolEnvelope<unknown>;
      const rendered = definition.output.render({}, value as unknown as JsonValue);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]).toMatchObject({ type: "text" });
      if (rendered[0]?.type === "text") expect(rendered[0].text).toContain(FIXED_TOOL_FOOTER);
    }
  });
});
