import { defineTool, type JsonValue, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import { FIXED_TOOL_FOOTER, type ToolEnvelope } from "../contracts.js";
import { operationContext, type ToolOperationContext } from "./context.js";

export type { ToolOperationContext } from "./context.js";

type ToolData = Record<string, JsonValue>;
type OperationResult = Omit<ToolEnvelope<ToolData>, "note">;

export interface InspectArguments {
  readonly file_ref: string;
}

export interface ReadArguments {
  readonly file_ref: string;
  readonly part_ref: string;
  readonly cursor?: string;
  readonly max_chars?: number;
  readonly range?: string;
}

export interface OcrArguments {
  readonly part_ref: string;
  readonly languages: string;
}

export interface RenderArguments {
  readonly part_ref: string;
  readonly scale?: number;
}

export interface FileToolOperations {
  inspect(context: ToolOperationContext, arguments_: InspectArguments): Promise<OperationResult>;
  read(context: ToolOperationContext, arguments_: ReadArguments): Promise<OperationResult>;
  ocr(context: ToolOperationContext, arguments_: OcrArguments): Promise<OperationResult>;
  render(context: ToolOperationContext, arguments_: RenderArguments): Promise<OperationResult>;
}

const OUTPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" as const, const: true, required: true },
    file_ref: { type: "string" as const, required: true },
    part_ref: { type: "string" as const },
    source_sha256: { type: "string" as const, required: true },
    parser: { type: "string" as const, required: true },
    locator: { type: "object" as const, additionalProperties: true, required: true },
    cursor: {
      required: true,
      oneOf: [{ type: "string" as const }, { type: "null" as const }]
    },
    data: { type: "object" as const, additionalProperties: true, required: true },
    note: { type: "string" as const, const: FIXED_TOOL_FOOTER, required: true }
  }
} as const;

const OUTPUT = {
  schema: OUTPUT_SCHEMA,
  render: (_arguments: unknown, value: JsonValue) => [
    { type: "text" as const, text: JSON.stringify(value, null, 2) }
  ]
};

function finish(result: OperationResult): ToolEnvelope<ToolData> {
  return Object.freeze({ ...result, note: FIXED_TOOL_FOOTER });
}

export function createFileToolDefinitions(operations: FileToolOperations): readonly ToolDefinition[] {
  return Object.freeze([
    defineTool({
      name: "file_inspect",
      description: "Inspect one uploaded file and return metadata, structure, and selectable part_ref values without automatically reading every part.",
      parameters: {
        file_ref: { type: "string", required: true, description: "Canonical dsh-open-file attachment reference." }
      },
      output: OUTPUT,
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      execute: async (arguments_, execution) =>
        finish(await operations.inspect(operationContext(execution), arguments_))
    }),
    defineTool({
      name: "file_read",
      description: "Read one explicitly selected structural part from an uploaded file using its native parser.",
      parameters: {
        file_ref: { type: "string", required: true, description: "Canonical attachment reference." },
        part_ref: { type: "string", required: true, description: "Exact part reference returned by file_inspect." },
        cursor: { type: "string", description: "Opaque continuation cursor returned by an earlier file_read." },
        max_chars: { type: "number", description: "Maximum text characters to return within configured limits." },
        range: { type: "string", description: "Optional native sub-range, such as Sheet!A1:B20." }
      },
      output: OUTPUT,
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      execute: async (arguments_, execution) =>
        finish(await operations.read(operationContext(execution), arguments_))
    }),
    defineTool({
      name: "file_ocr",
      description: "Run local English and/or Simplified-Chinese OCR on one explicitly selected image part.",
      parameters: {
        part_ref: { type: "string", required: true, description: "Exact image or rendered-image part reference." },
        languages: {
          type: "string",
          required: true,
          enum: ["eng", "chi_sim", "eng+chi_sim", "chi_sim+eng"],
          description: "Local OCR language selection."
        }
      },
      output: OUTPUT,
      timeoutMs: 120_000,
      execute: async (arguments_, execution) =>
        finish(await operations.ocr(operationContext(execution), arguments_))
    }),
    defineTool({
      name: "file_render",
      description: "Render one explicitly selected renderable part to a workspace-local image artifact.",
      parameters: {
        part_ref: { type: "string", required: true, description: "Exact renderable part reference returned by file_inspect." },
        scale: { type: "number", description: "Render scale between 0 and 8; defaults to 1.5." }
      },
      output: OUTPUT,
      timeoutMs: 30_000,
      execute: async (arguments_, execution) =>
        finish(await operations.render(operationContext(execution), arguments_))
    })
  ]);
}
