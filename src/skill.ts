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
    description: "Analyze uploaded files with structure inspection, native-part reading, local OCR, and render generation.",
    whenToUse: "Use when a user's request depends on the contents, structure, metadata, or visible text of a file uploaded through dsh-open-file, or when the conversation contains a dsh-open-file reference.",
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
