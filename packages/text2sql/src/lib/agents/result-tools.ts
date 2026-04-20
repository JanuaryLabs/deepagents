import chalk from 'chalk';
import { Bash, type IFileSystem, MountableFs, OverlayFs } from 'just-bash';
import * as path from 'node:path';
import { v7 } from 'uuid';

import {
  type SkillPathMapping,
  type SubcommandDefinition,
  buildSubcommandRepair,
  createBashTool,
  defineSubcommandGroup,
  repairQuotedArg,
  useBashMeta,
} from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';
import {
  SqlBacktickRewritePlugin,
  SqlProxyEnforcementPlugin,
} from './sql-transform-plugins.ts';

const SQL_VALIDATE_REMINDER =
  'Always run `sql validate` before `sql run` to catch syntax errors early.';

export function createSqlCommand(adapter: Adapter) {
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
          const rowsArray = Array.isArray(rows) ? rows : [];
          const content = JSON.stringify(rowsArray, null, 2);

          const filename = `${v7()}.json`;
          const sqlPath = `/sql/${filename}`;

          await ctx.fs.mkdir('/sql', { recursive: true });
          await ctx.fs.writeFile(sqlPath, content);
          meta?.setHidden({ resultPath: sqlPath });

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

/**
 * Options for creating result tools.
 */
export interface ResultToolsOptions {
  /** Database adapter for executing SQL queries */
  adapter: Adapter;
  /** Skill mounts mapping host paths to sandbox paths */
  skillMounts: SkillPathMapping[];
  /** Filesystem for storage */
  filesystem: IFileSystem;
}

/**
 * Creates bash tool with integrated sql command.
 *
 * The agent sees only one tool: `bash`
 * SQL is executed via: sql run "SELECT ..."
 */
export async function createResultTools(options: ResultToolsOptions) {
  const { adapter, skillMounts, filesystem: baseFs } = options;

  const { command: sqlCommand, repair: repairCommand } =
    createSqlCommand(adapter);

  const fsMounts = skillMounts.map(({ host, sandbox }) => ({
    mountPoint: path.dirname(sandbox),
    filesystem: new OverlayFs({
      root: path.dirname(host),
      mountPoint: '/',
      readOnly: true,
    }),
  }));

  const filesystem = new MountableFs({
    base: baseFs,
    mounts: fsMounts,
  });

  const bashInstance = new Bash({
    customCommands: [sqlCommand],
    fs: filesystem,
  });

  bashInstance.registerTransformPlugin(new SqlBacktickRewritePlugin());
  bashInstance.registerTransformPlugin(new SqlProxyEnforcementPlugin());

  const debug = Boolean(process.env.DEBUG_BASH);

  return createBashTool({
    sandbox: bashInstance,
    destination: '/',
    onBeforeBashCall: ({ command }) => {
      const repaired = repairCommand(command);
      if (debug) {
        console.log(chalk.cyan(`[onBeforeBashCall]: ${repaired}`));
      }
      return { command: repaired };
    },
    onAfterBashCall: ({ result }) => {
      if (debug && result.exitCode !== 0) {
        console.log(chalk.yellow(`[onAfterBashCall]: ${result.exitCode}`));
      }
      return { result };
    },
  });
}
