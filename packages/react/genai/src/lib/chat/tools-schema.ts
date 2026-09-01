import { z } from 'zod';

import type { ComponentRegistry } from '../tools/registry.ts';

export type SerializedToolRegistry = Record<
  string,
  {
    inputSchema: z.core.JSONSchema.BaseSchema;
    description: string;
  }
>;

export function serializeToolsRegistry(
  registry: ComponentRegistry,
): SerializedToolRegistry {
  return Object.entries(registry).reduce<SerializedToolRegistry>(
    (acc, [toolName, tool]) => {
      if (tool.static) {
        return acc;
      }
      acc[toolName] = {
        inputSchema: z.toJSONSchema(tool.inputSchema, {
          io: 'input',
          unrepresentable: 'any',
        }),
        description: tool.description,
      };
      return acc;
    },
    {},
  );
}
