import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Context } from "@deepseek-ai/cordis";
import type { SkillRegistration } from "@deepseek-ai/dsh-skill";

const SKILL_URL = new URL("../skills/open-file/SKILL.md", import.meta.url);

export const inject = ["skills"] as const;

export function skillRegistration(): SkillRegistration {
  return Object.freeze({
    name: "open-file",
    description: "Inspect, read, OCR, or render workspace-local uploaded files through four independent tools.",
    whenToUse: "Use when a user attaches an ordinary file or provides a dsh-open-file reference.",
    source: "bundled",
    invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
    resourceBase: Object.freeze({ kind: "directory", path: dirname(fileURLToPath(SKILL_URL)) }),
    content: readFileSync(SKILL_URL, "utf8")
  });
}

export function apply(context: Context): void {
  context.effect(function* registerOpenFileSkill() {
    yield context.skills.register(skillRegistration());
  }, "dsh-open-file.skill");
}
