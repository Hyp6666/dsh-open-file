import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { OpenFileError } from "../errors.js";
import { sessionDirectoryName } from "../references.js";

export interface SessionLayout {
  readonly workspace: string;
  readonly pluginRoot: string;
  readonly versionRoot: string;
  readonly sessionsRoot: string;
  readonly sessionRoot: string;
  readonly incoming: string;
  readonly files: string;
}

function workspaceError(message: string, cause?: unknown): OpenFileError {
  return new OpenFileError("FILE_WORKSPACE_UNAVAILABLE", message, undefined, { cause });
}

export function assertContainedPath(canonicalRoot: string, candidate: string): void {
  const root = resolve(canonicalRoot);
  const target = resolve(candidate);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw workspaceError("A managed path leaves the current workspace.");
}

async function ensureManagedDirectory(canonicalWorkspace: string, path: string): Promise<void> {
  assertContainedPath(canonicalWorkspace, path);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      const code = isNodeError(error) ? error.code : undefined;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        throw new OpenFileError("FILE_WORKSPACE_NOT_WRITABLE", "The workspace is not writable.", undefined, {
          cause: error
        });
      }
      throw workspaceError("A managed workspace directory could not be created.", error);
    }
  }

  try {
    const information = await lstat(path);
    if (information.isSymbolicLink() || !information.isDirectory()) {
      throw workspaceError("A managed workspace layer is not a real directory.");
    }
    const canonical = await realpath(path);
    assertContainedPath(canonicalWorkspace, canonical);
  } catch (error) {
    if (error instanceof OpenFileError) throw error;
    throw workspaceError("A managed workspace layer could not be verified.", error);
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

export async function prepareSessionLayout(workspace: string, sessionId: string): Promise<SessionLayout> {
  if (!isAbsolute(workspace)) {
    throw workspaceError("The session workspace must be an absolute path.");
  }

  let canonicalWorkspace: string;
  try {
    const information = await stat(workspace);
    if (!information.isDirectory()) throw workspaceError("The session workspace is not a directory.");
    canonicalWorkspace = await realpath(workspace);
    await access(canonicalWorkspace, constants.R_OK | constants.W_OK);
  } catch (error) {
    if (error instanceof OpenFileError) throw error;
    throw workspaceError("The session workspace is unavailable.", error);
  }

  const pluginRoot = join(canonicalWorkspace, ".dsh", "open-file");
  const versionRoot = join(pluginRoot, "v1");
  const sessionsRoot = join(versionRoot, "sessions");
  const sessionRoot = join(sessionsRoot, sessionDirectoryName(sessionId));
  const incoming = join(sessionRoot, "incoming");
  const files = join(sessionRoot, "files");

  const managedLayers = [
    join(canonicalWorkspace, ".dsh"),
    pluginRoot,
    versionRoot,
    sessionsRoot,
    sessionRoot,
    incoming,
    files
  ];
  for (const layer of managedLayers) await ensureManagedDirectory(canonicalWorkspace, layer);

  return Object.freeze({
    workspace: canonicalWorkspace,
    pluginRoot,
    versionRoot,
    sessionsRoot,
    sessionRoot,
    incoming,
    files
  });
}
