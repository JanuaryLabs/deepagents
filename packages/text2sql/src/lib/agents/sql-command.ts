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
  'Always run `sql validate` before `sql run` to catch syntax errors early.';

export interface SqlCommandOptions {
  /** Directory under which `sql run` writes result JSON files. Default: `/sql`. */
  outputDir?: string;
}

export function createSqlCommand(
  adapter: Adapter,
  { outputDir = '/sql' }: SqlCommandOptions = {},
) {
  const subcommands = {
    run: {
      usage: 'run "SELECT ..."',
      description: 'Execute query and store results',
      repair: repairQuotedArg,
      handler: async (args, ctx) => {
        const meta = useBashMeta();
        meta?.setReminder(SQL_VALIDATE_REMINDER);

        const rawQuery = args.join(' ').trim();

        if (!rawQuery) {
          return {
            stdout: '',
            stderr: 'sql run: no query provided',
            exitCode: 1,
          };
        }

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
      usage: 'validate "SELECT ..."',
      description: 'Validate query syntax',
      repair: repairQuotedArg,
      handler: async (args) => {
        const meta = useBashMeta();
        const rawQuery = args.join(' ').trim();

        if (!rawQuery) {
          return {
            stdout: '',
            stderr: 'sql validate: no query provided',
            exitCode: 1,
          };
        }

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
