import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("publishable package contract", () => {
  it("declares host, browser ModuleLoader, Skill, and discovery metadata", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      name: string;
      exports: Record<string, { default?: string }>;
      scripts: Record<string, string>;
      files: string[];
      keywords: string[];
      repository?: { type?: string; url?: string };
      bugs?: { url?: string };
      homepage?: string;
      publishConfig?: { access?: string };
      packageManager?: string;
      dsh: { client: { platform: string; inject: string[] } };
      peerDependencies: Record<string, string>;
    };
    expect(packageJson.name).toBe("dsh-open-file");
    expect(packageJson.exports["."]?.default).toBe("./lib/index.js");
    expect(packageJson.exports["./client"]?.default).toBe("./lib/client.js");
    expect(packageJson.exports["./skill"]?.default).toBe("./lib/skill.js");
    expect(packageJson.exports["./cordis.patch.yml"]?.default).toBe("./cordis.patch.yml");
    expect(packageJson.scripts.build).toContain("build-client.mjs");
    expect(packageJson.scripts.prepack).toBe("npm run verify:release");
    expect(packageJson.scripts.prepublishOnly).toBe("node scripts/verify-publish.mjs");
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "lib",
      "skills",
      "cordis.patch.yml",
      "assets/dsh-open-file-drop.png",
      "assets/dsh-open-file-formats.png"
    ]));
    expect(packageJson.keywords).toContain("dsh-plugin");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/hyper-dsh-plugins/dsh-open-file.git"
    });
    expect(packageJson.bugs?.url).toBe("https://github.com/hyper-dsh-plugins/dsh-open-file/issues");
    expect(packageJson.homepage).toBe("https://github.com/hyper-dsh-plugins/dsh-open-file#readme");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.packageManager).toBe("npm@11.9.0");
    expect(packageJson.dsh.client.platform).toBe("web");
    expect(packageJson.dsh.client.inject).toContain("@deepseek-ai/dsh-client-runtime");
  });

  it.each([
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
    "SECURITY.md",
    ".gitignore",
    "assets/dsh-open-file-drop.png",
    "assets/dsh-open-file-formats.png"
  ])(
    "ships %s",
    async (file) => {
      await expect(access(join(root, file))).resolves.toBeUndefined();
    }
  );

  it("runs the release checks on Windows, Linux, and macOS", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm run lint");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm run verify:pack");
  });

  it("bundles local OCR assets and excludes source/test/profile data from published files", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      files: string[];
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      dependenciesMeta?: Record<string, { built?: boolean }>;
      bundledDependencies?: string[];
    };
    expect(packageJson.devDependencies).toMatchObject({
      "@tesseract.js-data/eng": "1.0.0",
      "@tesseract.js-data/chi_sim": "1.0.0"
    });
    expect(packageJson.dependencies).not.toHaveProperty("@tesseract.js-data/eng");
    expect(packageJson.dependencies).not.toHaveProperty("@tesseract.js-data/chi_sim");
    expect(packageJson.dependenciesMeta?.["tesseract.js"]?.built).toBe(false);
    expect(packageJson.bundledDependencies).toContain("tesseract.js");
    expect(packageJson.files).not.toEqual(expect.arrayContaining(["src", "test", ".dsh"]));
  });

  it("blocks publication when the reviewed package identity changes", async () => {
    const guard = await readFile(join(root, "scripts", "verify-publish.mjs"), "utf8");
    expect(guard).toContain("dsh-open-file");
    expect(guard).toContain("git+https://github.com/hyper-dsh-plugins/dsh-open-file.git");
    expect(guard).toContain("npm publish is blocked");
  });

  it("rejects source maps and private repository-only paths from the npm artifact", async () => {
    const verifier = await readFile(join(root, "scripts", "verify-pack.mjs"), "utf8");
    expect(verifier).toContain("source map");
    expect(verifier).toContain(".playwright-cli");
    expect(verifier).toContain("output");
    expect(verifier).toContain("scripts");
  });
});
