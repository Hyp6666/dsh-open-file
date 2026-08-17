import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OpenFileError } from "../errors.js";
import { assertContainedPath } from "./layout.js";

export async function writeJsonAtomic(
  workspace: string,
  target: string,
  value: unknown
): Promise<void> {
  assertContainedPath(workspace, target);
  const parent = dirname(target);
  const temporary = join(parent, `.${randomUUID()}.json.part`);
  assertContainedPath(workspace, temporary);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      const information = await lstat(target);
      if (information.isSymbolicLink() || !information.isFile()) {
        throw new OpenFileError("FILE_WORKSPACE_UNAVAILABLE", "A metadata path is not a regular file.");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readJson<T>(workspace: string, target: string): Promise<T> {
  assertContainedPath(workspace, target);
  try {
    const information = await lstat(target);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new OpenFileError("FILE_WORKSPACE_UNAVAILABLE", "A metadata path is not a regular file.");
    }
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error) {
    if (error instanceof OpenFileError) throw error;
    throw error;
  }
}
