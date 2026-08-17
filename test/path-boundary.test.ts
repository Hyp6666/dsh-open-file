import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OpenFileError } from "../src/errors.js";
import {
  assertContainedPath,
  prepareSessionLayout,
  type SessionLayout
} from "../src/storage/layout.js";
import { sessionDirectoryName } from "../src/references.js";

const temporaryRoots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-open-file-layout-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace boundary", () => {
  it("rejects a relative or missing workspace", async () => {
    await expect(prepareSessionLayout("relative", "s1")).rejects.toMatchObject({
      code: "FILE_WORKSPACE_UNAVAILABLE"
    });
    await expect(prepareSessionLayout(resolve(tmpdir(), "definitely-missing-dsh-open-file"), "s1"))
      .rejects.toMatchObject({ code: "FILE_WORKSPACE_UNAVAILABLE" });
  });

  it("creates the versioned session tree inside the canonical workspace", async () => {
    const root = await workspace();
    const layout = await prepareSessionLayout(root, "session/raw");
    expect(layout.workspace).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(root)));
    expect(layout.sessionRoot).toBe(
      join(layout.workspace, ".dsh", "open-file", "v1", "sessions", sessionDirectoryName("session/raw"))
    );
    for (const path of [layout.pluginRoot, layout.sessionRoot, layout.incoming, layout.files]) {
      expect(() => assertContainedPath(layout.workspace, path)).not.toThrow();
    }
    expect(layout.sessionRoot).not.toContain("session/raw");
  });

  it("rejects paths that leave the canonical root or merely share its prefix", async () => {
    const root = await workspace();
    expect(() => assertContainedPath(root, join(root, "..", "escape"))).toThrowError(OpenFileError);
    expect(() => assertContainedPath(root, `${root}-other/file`)).toThrowError(OpenFileError);
  });

  it("rejects a symbolic link at every managed directory layer", async () => {
    const sessionId = "link-session";
    const relativeLayers = [
      ".dsh",
      ".dsh/open-file",
      ".dsh/open-file/v1",
      ".dsh/open-file/v1/sessions",
      `.dsh/open-file/v1/sessions/${sessionDirectoryName(sessionId)}`,
      `.dsh/open-file/v1/sessions/${sessionDirectoryName(sessionId)}/incoming`,
      `.dsh/open-file/v1/sessions/${sessionDirectoryName(sessionId)}/files`
    ];

    for (const relativeLayer of relativeLayers) {
      const root = await workspace();
      const target = await workspace();
      const layer = join(root, ...relativeLayer.split("/"));
      await mkdir(dirname(layer), { recursive: true });
      await symlink(target, layer, "dir");
      await expect(prepareSessionLayout(root, sessionId)).rejects.toMatchObject({
        code: "FILE_WORKSPACE_UNAVAILABLE"
      });
    }
  });

  it("rejects a regular file where a managed directory is required", async () => {
    const root = await workspace();
    await writeFile(join(root, ".dsh"), "not a directory", "utf8");
    await expect(prepareSessionLayout(root, "s1")).rejects.toMatchObject({
      code: "FILE_WORKSPACE_UNAVAILABLE"
    });
  });

  it("returns an immutable layout value", async () => {
    const layout: SessionLayout = await prepareSessionLayout(await workspace(), "s1");
    expect(Object.isFrozen(layout)).toBe(true);
  });
});
