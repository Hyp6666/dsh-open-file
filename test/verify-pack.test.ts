import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

describe("npm pack invocation", () => {
  it("launches the npm CLI through Node when npm_execpath is available", () => {
    const moduleUrl = pathToFileURL(`${process.cwd()}/scripts/npm-invocation.mjs`).href;
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { npmInvocation } from ${JSON.stringify(moduleUrl)};` +
          `process.stdout.write(JSON.stringify(npmInvocation({` +
          `npmExecPath:"C:/npm/npm-cli.js",nodeExecPath:"C:/node/node.exe"` +
          `},["pack","--dry-run"])));`
      ],
      { encoding: "utf8" }
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      command: "C:/node/node.exe",
      args: ["C:/npm/npm-cli.js", "pack", "--dry-run"]
    });
  });
});
