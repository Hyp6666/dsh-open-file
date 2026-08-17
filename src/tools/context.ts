import { isAbsolute } from "node:path";

import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

import { OpenFileError } from "../errors.js";

export interface ToolOperationContext {
  readonly workspace: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export function operationContext(execution: ToolRunContext): ToolOperationContext {
  const agent = execution.agent;
  const workspace = agent?.session.header.cwd;
  if (agent === undefined || workspace === undefined || !isAbsolute(workspace)) {
    throw new OpenFileError(
      "FILE_WORKSPACE_UNAVAILABLE",
      "The tool requires an agent session with an absolute workspace."
    );
  }
  return Object.freeze({
    workspace,
    sessionId: String(agent.id),
    signal: execution.signal
  });
}
