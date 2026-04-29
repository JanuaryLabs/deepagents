import type { Client } from '@sdk-it/rpc';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { SubcommandDefinition } from '../subcommand.ts';
import { formatError, formatResponse } from './format.ts';

export interface SchemaEntry {
  endpoint: string;
  operationId: string;
  summary?: string;
}

export function buildSchemaSubcommand(
  group: string,
  client: Client,
  entries: SchemaEntry[],
): SubcommandDefinition {
  return {
    usage: 'schema',
    description: 'Dump JSON Schema for every operation in this group.',
    handler: async () => {
      try {
        const operations = entries.map((entry) => {
          const [method, path] = entry.endpoint.split(' ');
          const zodSchema = client.schemas[entry.endpoint]?.schema;
          const input = zodSchema
            ? zodToJsonSchema(zodSchema, {
                target: 'jsonSchema7',
                $refStrategy: 'none',
              })
            : {};
          return entry.summary
            ? {
                operationId: entry.operationId,
                method,
                path,
                summary: entry.summary,
                input,
              }
            : { operationId: entry.operationId, method, path, input };
        });
        return formatResponse({ group, operations });
      } catch (error) {
        return formatError({
          group,
          operation: 'schema',
          code: 'schema_dump_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
