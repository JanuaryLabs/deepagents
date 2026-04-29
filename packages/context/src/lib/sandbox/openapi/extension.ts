import { type Client, rpc } from '@sdk-it/rpc';
import {
  type OperationEntry,
  type TunedOperationObject,
  forEachOperation,
  loadSpec,
  toIR,
} from '@sdk-it/spec';

import type {
  BashCallHook,
  ExtensionCommand,
  SandboxExtension,
} from '../extension.ts';
import {
  type SubcommandDefinition,
  buildSubcommandRepair,
  defineSubcommandGroup,
  repairQuotedArg,
} from '../subcommand.ts';
import { formatError, formatResponse } from './format.ts';
import { type SchemaEntry, buildSchemaSubcommand } from './schema.ts';
import { extractPathParams, findUnsafePathParam } from './validate.ts';

export interface OpenAPIExtensionOptions {
  name: string;
  openapi: string;
  baseUrl?: string;
  token?: string | (() => string | Promise<string>);
  headers?: Record<string, string>;
  fetch?: (req: Request) => Promise<Response>;
  includeOperation?: (
    entry: OperationEntry,
    operation: TunedOperationObject,
  ) => boolean;
}

export interface OpenAPIExtension extends SandboxExtension {
  commands: ExtensionCommand[];
  onBeforeBashCall: BashCallHook;
  client: Client;
}

interface PlannedSubcommand {
  subName: string;
  endpoint: string;
  description: string;
  summary?: string;
  pathParamNames: string[];
}

const RESERVED_SUBCOMMAND = 'schema';

function serializeError(err: unknown): unknown {
  if (err === null || err === undefined) return err;
  if (typeof err !== 'object') return String(err);
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    for (const key of Object.getOwnPropertyNames(err)) {
      if (key === 'stack') continue;
      const value = (err as unknown as Record<string, unknown>)[key];
      out[key] = key === 'cause' ? serializeError(value) : value;
    }
    return out;
  }
  return err;
}

export async function createOpenAPIExtension(
  options: OpenAPIExtensionOptions,
): Promise<OpenAPIExtension> {
  const { name, openapi, includeOperation, ...clientOptions } = options;

  const ir = toIR({
    spec: await loadSpec(openapi),
    responses: { flattenErrorResponses: true },
  });

  if ((ir.servers?.length ?? 0) === 0 && !clientOptions.baseUrl) {
    throw new Error(
      `createOpenAPIExtension("${name}"): openapi spec has no servers and no baseUrl was provided`,
    );
  }

  const planned: PlannedSubcommand[] = [];
  const registered = new Map<string, string>();

  forEachOperation(ir, (entry, operation) => {
    if (includeOperation && !includeOperation(entry, operation)) return;

    const subName = operation['x-fn-name'] || operation.operationId;
    const endpoint = `${entry.method.toUpperCase()} ${entry.path}`;

    if (!subName) {
      throw new Error(
        `createOpenAPIExtension("${name}"): operation ${endpoint} has no x-fn-name or operationId`,
      );
    }
    if (subName === RESERVED_SUBCOMMAND) {
      throw new Error(
        `createOpenAPIExtension("${name}"): operation name "${RESERVED_SUBCOMMAND}" is reserved for introspection`,
      );
    }

    const existing = registered.get(subName);
    if (existing) {
      throw new Error(
        `createOpenAPIExtension("${name}"): duplicate subcommand "${subName}" (from ${existing} and ${endpoint})`,
      );
    }
    registered.set(subName, endpoint);

    planned.push({
      subName,
      endpoint,
      description: operation.summary || operation.description || endpoint,
      summary: operation.summary,
      pathParamNames: extractPathParams(entry.path),
    });
  });

  if (planned.length === 0) {
    throw new Error(
      `createOpenAPIExtension("${name}"): no operations matched; spec has no operations or includeOperation filtered all of them out`,
    );
  }

  const client = await rpc(openapi, clientOptions);

  const subcommands: Record<string, SubcommandDefinition> = {};
  const schemaEntries: SchemaEntry[] = [];

  for (const {
    subName,
    endpoint,
    description,
    summary,
    pathParamNames,
  } of planned) {
    const schema = client.schemas[endpoint]?.schema;
    if (!schema) {
      throw new Error(
        `createOpenAPIExtension("${name}"): no input schema for ${endpoint}`,
      );
    }

    schemaEntries.push({ endpoint, operationId: subName, summary });

    subcommands[subName] = {
      usage: `${subName} '<json>'`,
      description,
      repair: repairQuotedArg,
      handler: async (args, ctx) => {
        const raw = args.join(' ').trim();
        if (!raw) {
          return formatError({
            group: name,
            operation: subName,
            code: 'missing_input',
            message: 'no input provided',
          });
        }

        let input: unknown;
        try {
          input = JSON.parse(raw);
        } catch (error) {
          return formatError({
            group: name,
            operation: subName,
            code: 'invalid_json',
            message: error instanceof Error ? error.message : String(error),
          });
        }

        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          return formatError({
            group: name,
            operation: subName,
            code: 'schema_validation',
            message: parsed.error.message,
            extra: { issues: parsed.error.issues },
          });
        }

        const unsafe = findUnsafePathParam(parsed.data, pathParamNames);
        if (unsafe) {
          return formatError({
            group: name,
            operation: subName,
            code: 'path_param_unsafe',
            message: `path parameter '${unsafe.field}' ${unsafe.reason}`,
            extra: { field: unsafe.field },
          });
        }

        try {
          const response = await client.request(endpoint, parsed.data, {
            signal: ctx.signal,
          });
          return formatResponse(response);
        } catch (error) {
          return formatError({
            group: name,
            operation: subName,
            code: 'request_failed',
            message: error instanceof Error ? error.message : String(error),
            extra: { error: serializeError(error) },
          });
        }
      },
    };
  }

  subcommands[RESERVED_SUBCOMMAND] = buildSchemaSubcommand(
    name,
    client,
    schemaEntries,
  );

  const command = defineSubcommandGroup(name, subcommands);
  const repair = buildSubcommandRepair(name, subcommands);
  return {
    commands: [command],
    onBeforeBashCall: ({ command: raw }) => ({ command: repair(raw) }),
    client,
  };
}
