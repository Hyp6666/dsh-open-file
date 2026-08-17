import type {
  InputTriggerCandidate,
  InputTriggerServiceContract,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";

export interface AddAttachmentSourceOptions {
  locale: string;
  openPicker(sessionId: string): void;
}

function includesQuery(candidate: InputTriggerCandidate, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;

  return [candidate.name, candidate.description]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function addAttachmentSourceName(locale: string): string {
  return locale.toLocaleLowerCase().startsWith("zh") ? "添加" : "Add";
}

export function installAddAttachmentSource(
  service: Pick<InputTriggerServiceContract, "registerSource">,
  options: AddAttachmentSourceOptions,
): () => void {
  const chinese = options.locale.toLocaleLowerCase().startsWith("zh");
  const candidate = Object.freeze<InputTriggerCandidate>({
    name: chinese ? "附件" : "Attachment",
    description: chinese
      ? "从本机选择一个或多个文件"
      : "Choose one or more files from this device",
    // rc.6 renders an icon span whenever icon is defined. Its public icon
    // value is text-only, so the empty slot is painted by our scoped SVG mask.
    icon: "",
  });

  return service.registerSource({
    trigger: "/",
    name: addAttachmentSourceName(options.locale),
    order: 10,
    candidates: (_session, request) => Promise.resolve(
      includesQuery(candidate, request.query) ? [candidate] : [],
    ),
    onPick: (pick) => {
      if (pick.candidate !== candidate) return undefined;
      options.openPicker(String(pick.session.sessionId));
      return "handled";
    },
  });
}
