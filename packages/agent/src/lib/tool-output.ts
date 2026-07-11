import type { JSONValue } from '@ai-sdk/provider';
import type { ToolSet } from 'ai';

type ToolWithModelOutput<T extends ToolSet[string]> = T & {
  toModelOutput: NonNullable<T['toModelOutput']>;
};

type ToolSetWithModelOutput<TOOLS extends ToolSet> = {
  [NAME in keyof TOOLS]: ToolWithModelOutput<TOOLS[NAME]>;
};

/** Add a default projection that omits top-level `meta` from model output. */
export function withHostOnlyToolMetadata<TOOLS extends ToolSet>(
  tools: TOOLS,
): ToolSetWithModelOutput<TOOLS> {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    wrapped[name] =
      tool.toModelOutput !== undefined
        ? tool
        : {
            ...tool,
            toModelOutput: ({ output }: { output: unknown }) =>
              defaultToolModelOutput(output),
          };
  }
  return wrapped as ToolSetWithModelOutput<TOOLS>;
}

function defaultToolModelOutput(output: unknown) {
  if (
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    Object.hasOwn(output, 'meta')
  ) {
    const { meta: _meta, ...visible } = output as Record<string, unknown>;
    return { type: 'json' as const, value: visible as JSONValue };
  }
  return typeof output === 'string'
    ? { type: 'text' as const, value: output }
    : { type: 'json' as const, value: (output ?? null) as JSONValue };
}
