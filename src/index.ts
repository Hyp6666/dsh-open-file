import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import { SessionId } from "@deepseek-ai/dsh-session";

import { createOpenFileHttpHandler } from "./http/router.js";
import { createFileToolDefinitions } from "./tools/index.js";
import { FileOperations } from "./tools/operations.js";
import { UploadService } from "./upload/service.js";

export const inject = ["tools", "agents", "webServer"] as const;

export function apply(context: Context): void {
  const operations = new FileOperations();
  const uploads = new UploadService({
    resolveWorkspace: (sessionId) => {
      const agent = context.agents.get(SessionId(sessionId));
      return Promise.resolve(agent?.session.header.cwd ?? null);
    }
  });
  const handler = createOpenFileHttpHandler(uploads);
  context.effect(function* registerOpenFileHost() {
    for (const definition of createFileToolDefinitions(operations)) {
      yield context.tools.register(definition);
    }
    yield context.webServer.register({
      kind: "prefix",
      path: "/dsh-open-file/v1",
      handler
    });
  }, "dsh-open-file.host");
}
