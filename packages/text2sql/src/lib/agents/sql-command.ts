import { v7 } from 'uuid';

import {
  type SubcommandDefinition,
  buildSubcommandRepair,
  defineSubcommandGroup,
  repairQuotedArg,
  useBashMeta,
} from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';

const SQL_VALIDATE_REMINDER =
  'Always run `sql validate <db> "..."` before `sql run <db> "..."` to catch syntax errors early.';

export interface SqlCommandOptions {
  /** Directory under which `sql run` writes result JSON files. Default: `/sql`. */
  outputDir?: string;
}

function repairDbNameAndQuotedArg(rawArgs: string): string | null {
  const trimmed = rawArgs.trim();
  if (!trimmed) return null;
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return null;
  const dbName = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1);
  const repaired = repairQuotedArg(rest);
  if (repaired == null) return null;
  return `${dbName} ${repaired}`;
}

function resolveAdapter(
  adapters: Record<string, Adapter>,
  subcommand: string,
  args: string[],
): { adapter: Adapter; sql: string } | { error: string } {
  const [name, ...rest] = args;
  const available = Object.keys(adapters).join(', ');
  if (!name) {
    return {
      error: `sql ${subcommand}: missing database name. Usage: sql ${subcommand} <db> "SELECT ...". Available: ${available}`,
    };
  }
  const adapter = adapters[name];
  if (!adapter) {
    return {
      error: `sql ${subcommand}: unknown database "${name}". Available: ${available}`,
    };
  }
  const sql = rest.join(' ').trim();
  if (!sql) {
    return { error: `sql ${subcommand}: no query provided` };
  }
  return { adapter, sql };
}

export function createSqlCommand(
  adapters: Record<string, Adapter>,
  { outputDir = '/sql' }: SqlCommandOptions = {},
) {
  const subcommands = {
    run: {
      usage: 'run <db> "SELECT ..."',
      description: 'Execute query against <db> and store results',
      repair: repairDbNameAndQuotedArg,
      handler: async (args, ctx) => {
        const meta = useBashMeta();
        meta?.setReminder(SQL_VALIDATE_REMINDER);

        const resolved = resolveAdapter(adapters, 'run', args);
        if ('error' in resolved) {
          return { stdout: '', stderr: resolved.error, exitCode: 1 };
        }
        const { adapter, sql: rawQuery } = resolved;

        const query = adapter.format(rawQuery);
        meta?.setHidden({ formattedSql: query });

        const syntaxError = await adapter.validate(query);
        if (syntaxError) {
          return {
            stdout: '',
            stderr: `sql run: ${syntaxError}`,
            exitCode: 1,
          };
        }

        try {
          const rows = await adapter.execute(query);
          if (!Array.isArray(rows)) {
            throw new Error('adapter.execute must return an array of rows');
          }
          const rowsArray = rows;
          const content = JSON.stringify(rowsArray, null, 2);

          const filename = `${v7()}.json`;
          const sqlPath = `${outputDir}/${filename}`;

          const mkdir = await ctx.sandbox.executeCommand(
            `mkdir -p ${outputDir}`,
          );
          if (mkdir.exitCode !== 0) {
            return {
              stdout: '',
              stderr: `sql run: failed to create ${outputDir}: ${mkdir.stderr}`,
              exitCode: 1,
            };
          }
          await ctx.sandbox.writeFiles([{ path: sqlPath, content }]);

          const columns =
            rowsArray.length > 0 ? Object.keys(rowsArray[0] as object) : [];

          return {
            stdout:
              [
                `results stored in ${sqlPath}`,
                `columns: ${columns.join(', ') || '(none)'}`,
                `rows: ${rowsArray.length}`,
              ].join('\n') + '\n',
            stderr: '',
            exitCode: 0,
          };
        } catch (error) {
          return {
            stdout: '',
            stderr: `sql run: ${error instanceof Error ? error.message : String(error)}`,
            exitCode: 1,
          };
        }
      },
    },
    validate: {
      usage: 'validate <db> "SELECT ..."',
      description: 'Validate query syntax against <db>',
      repair: repairDbNameAndQuotedArg,
      handler: async (args) => {
        const meta = useBashMeta();

        const resolved = resolveAdapter(adapters, 'validate', args);
        if ('error' in resolved) {
          return { stdout: '', stderr: resolved.error, exitCode: 1 };
        }
        const { adapter, sql: rawQuery } = resolved;

        const query = adapter.format(rawQuery);
        meta?.setHidden({ formattedSql: query });

        const syntaxError = await adapter.validate(query);
        if (syntaxError) {
          return {
            stdout: '',
            stderr: `sql validate: ${syntaxError}`,
            exitCode: 1,
          };
        }

        return {
          stdout: 'valid\n',
          stderr: '',
          exitCode: 0,
        };
      },
    },
  } satisfies Record<string, SubcommandDefinition>;

  const command = defineSubcommandGroup('sql', subcommands);
  const repair = buildSubcommandRepair('sql', subcommands);
  return { command, repair };
}

export type { SqlCommandOptions as CreateSqlCommandOptions };
