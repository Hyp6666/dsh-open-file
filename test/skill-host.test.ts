import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { Context } from "@deepseek-ai/cordis";

import { apply, inject } from "../src/index.js";
import { apply as applySkill, inject as skillInject, skillRegistration } from "../src/skill.js";
import { FIXED_TOOL_FOOTER } from "../src/contracts.js";

describe("bundled open-file Skill", () => {
  it("is packaged, model/user invocable, and preserves LLM choice", async () => {
    const registration = skillRegistration();
    expect(registration).toMatchObject({
      name: "open-file",
      description: expect.stringContaining("uploaded files"),
      whenToUse: expect.stringContaining("user's request depends"),
      source: "bundled",
      invocation: { modelInvocable: true, userInvocable: true }
    });
    expect(registration.content).toContain("file_inspect");
    expect(registration.content).toContain("file_read");
    expect(registration.content).toContain("file_ocr");
    expect(registration.content).toContain("file_render");
    expect(registration.content).toContain(FIXED_TOOL_FOOTER);
    expect(registration.content).not.toMatch(/detect (?:vision|multimodal)|probe (?:vision|capability)/iu);
    const disk = await readFile(new URL("../skills/open-file/SKILL.md", import.meta.url), "utf8");
    expect(registration.content).toBe(disk);
  });
});

describe("host plugin registration", () => {
  it("declares only the required public rc.6 services", () => {
    expect(inject).toEqual(["tools", "agents", "webServer"]);
    expect(skillInject).toEqual(["skills"]);
  });

  it("registers four tools, one separately loadable Skill, and one prefix route", () => {
    const toolDefinitions: unknown[] = [];
    const skills: unknown[] = [];
    const routes: unknown[] = [];
    const context = {
      tools: { register: vi.fn((definition: unknown) => (toolDefinitions.push(definition), () => undefined)) },
      skills: { register: vi.fn((registration: unknown) => (skills.push(registration), () => undefined)) },
      agents: { get: vi.fn(() => undefined) },
      webServer: { register: vi.fn((route: unknown) => (routes.push(route), () => undefined)) },
      effect: vi.fn((execute: () => Iterable<() => void>) => {
        [...execute()];
        return () => Promise.resolve();
      })
    } as unknown as Context;
    apply(context);
    applySkill(context);
    expect(toolDefinitions).toHaveLength(4);
    expect(skills).toHaveLength(1);
    expect(routes).toEqual([
      expect.objectContaining({ kind: "prefix", path: "/dsh-open-file/v1" })
    ]);
  });
});
