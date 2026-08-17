import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { npmInvocation } from "./npm-invocation.mjs";

const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const npm = npmInvocation(
  {
    npmExecPath: process.env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform
  },
  npmArgs
);
const cache = mkdtempSync(join(tmpdir(), "dsh-open-file-npm-cache-"));
const result = spawnSync(
  npm.command,
  npm.args,
  {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, npm_config_cache: cache },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }
);
rmSync(cache, { recursive: true, force: true });
if (result.error !== undefined) throw result.error;
if (result.status !== 0) throw new Error(`npm pack exited with status ${result.status ?? "unknown"}.`);
const reports = JSON.parse(result.stdout);
const report = reports[0];
if (report === undefined || !Array.isArray(report.files)) {
  throw new Error("npm pack returned no inspectable file list.");
}
const files = new Set(report.files.map((entry) => entry.path));
const bundled = new Set(Array.isArray(report.bundled) ? report.bundled : []);
for (const required of [
  "package.json",
  "lib/index.js",
  "lib/client.js",
  "lib/skill.js",
  "lib/tessdata/eng.traineddata.gz",
  "lib/tessdata/chi_sim.traineddata.gz",
  "skills/open-file/SKILL.md",
  "cordis.patch.yml",
  "README.md",
  "README.zh-CN.md",
  "assets/dsh-open-file-drop.png",
  "assets/dsh-open-file-formats.png",
  "LICENSE",
  "SECURITY.md"
]) {
  if (!files.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
}
for (const path of files) {
  if (/^(?:src|test|docs|scripts|output|\.dsh|\.github|\.playwright-cli)(?:\/|$)/u.test(path)) {
    throw new Error(`Packed artifact contains excluded path ${path}.`);
  }
  if (path.startsWith("lib/") && path.endsWith(".map")) {
    throw new Error(`Packed artifact contains source map ${path}.`);
  }
  if (path.startsWith("node_modules/")) {
    const segments = path.split("/");
    const first = segments[1];
    const packageName = first?.startsWith("@")
      ? `${first}/${segments[2] ?? ""}`
      : first;
    if (packageName === undefined || !bundled.has(packageName)) {
      throw new Error(`Packed artifact contains undeclared bundled path ${path}.`);
    }
  }
}
process.stdout.write(
  `${JSON.stringify({ filename: report.filename, files: files.size, size: report.size }, null, 2)}\n`
);
