import { type JSONValue, isJSONValue } from '@ai-sdk/provider';
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
    if (tool.toModelOutput !== undefined) {
      wrapped[name] = tool;
      continue;
    }
    // An own `toModelOutput` that is undefined must not replace the default.
    const descriptors = Object.getOwnPropertyDescriptors(tool);
    Reflect.deleteProperty(descriptors, 'toModelOutput');
    wrapped[name] = Object.defineProperties(
      {
        ...tool,
        toModelOutput: ({ output }: { output: unknown }) =>
          defaultToolModelOutput(output),
      },
      descriptors,
    );
  }
  if (!projectsEveryTool(tools, wrapped)) {
    throw new Error(
      'withHostOnlyToolMetadata left a tool without a projection',
    );
  }
  return wrapped;
}

/** Whether `wrapped` projects every tool of `tools` for the model. */
function projectsEveryTool<TOOLS extends ToolSet>(
  tools: TOOLS,
  wrapped: ToolSet,
): wrapped is ToolSetWithModelOutput<TOOLS> {
  return Object.keys(tools).every(
    (name) =>
      Object.hasOwn(wrapped, name) && wrapped[name].toModelOutput !== undefined,
  );
}

function defaultToolModelOutput(output: unknown) {
  return typeof output === 'string'
    ? { type: 'text' as const, value: output }
    : { type: 'json' as const, value: toJSONValue(withoutMeta(output)) };
}

/** A top-level `meta` field is for the host, not the model. */
function withoutMeta(output: unknown): unknown {
  if (
    typeof output !== 'object' ||
    output === null ||
    Array.isArray(output) ||
    !Object.hasOwn(output, 'meta')
  ) {
    return output;
  }
  const visible = { ...output };
  Reflect.deleteProperty(visible, 'meta');
  return visible;
}

/**
 * Tool outputs are whatever the tool returned, not necessarily JSON. A JSON
 * value passes through unchanged; anything else is normalized the way the AI
 * SDK normalizes outputs of tools without toModelOutput: a JSON round trip.
 */
function toJSONValue(value: unknown): JSONValue {
  if (isJSONValue(value)) {
    return value;
  }
  const serialized: string | undefined = JSON.stringify(value);
  if (serialized === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(serialized);
  return isJSONValue(parsed) ? parsed : null;
}
