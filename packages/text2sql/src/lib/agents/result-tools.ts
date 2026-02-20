import { tool } from 'ai';
import { createBashTool } from 'bash-tool';
import chalk from 'chalk';
import {
  Bash,
  type CommandContext,
  type IFileSystem,
  MountableFs,
  OverlayFs,
  defineCommand,
} from 'just-bash';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { v7 } from 'uuid';
import z from 'zod';

import type { SkillPathMapping } from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SubcommandDefinition {
  usage: string;
  description: string;
  handler: (
    args: string[],
    ctx: CommandContext,
  ) => CommandResult | Promise<CommandResult>;
}

/**
 * Creates a command with subcommands using a declarative API.
 *
 * @example
 * const cmd = createCommand('sql', {
 *   run: {
 *     usage: 'run "SELECT ..."',
 *     description: 'Execute query',
 *     handler: async (args, ctx) => ({ stdout: '...', stderr: '', exitCode: 0 })
 *   }
 * });
 */
function createCommand(
  name: string,
  subcommands: Record<string, SubcommandDefinition>,
) {
  const usageLines = Object.entries(subcommands)
    .map(([, def]) => `  ${name} ${def.usage.padEnd(30)} ${def.description}`)
    .join('\n');

  return defineCommand(name, async (args, ctx) => {
    const subcommand = args[0];
    const restArgs = args.slice(1);

    if (subcommand && subcommand in subcommands) {
      return subcommands[subcommand].handler(restArgs, ctx);
    }

    return {
      stdout: '',
      stderr: `${name}: ${subcommand ? `unknown subcommand '${subcommand}'` : 'missing subcommand'}\n\nUsage:\n${usageLines}`,
      exitCode: 1,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that a query is read-only (SELECT or WITH).
 */
function validateReadOnly(query: string): { valid: boolean; error?: string } {
  const upper = query.toUpperCase().trim();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { valid: false, error: 'only SELECT or WITH queries allowed' };
  }
  return { valid: true };
}

type MetaStore = AsyncLocalStorage<{ value?: Record<string, unknown> }>;

function createSqlCommand(adapter: Adapter, metaStore: MetaStore) {
  return createCommand('sql', {
    run: {
      usage: 'run "SELECT ..."',
      description: 'Execute query and store results',
      handler: async (args, ctx) => {
        const rawQuery = args.join(' ').trim();

        if (!rawQuery) {
          return {
            stdout: '',
            stderr: 'sql run: no query provided',
            exitCode: 1,
          };
        }

        const validation = validateReadOnly(rawQuery);
        if (!validation.valid) {
          return {
            stdout: '',
            stderr: `sql run: ${validation.error}`,
            exitCode: 1,
          };
        }

        const query = adapter.format(rawQuery);
        const store = metaStore.getStore();
        if (store) store.value = { formattedSql: query };

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
      handler: async (args) => {
        const rawQuery = args.join(' ').trim();

        if (!rawQuery) {
          return {
            stdout: '',
            stderr: 'sql validate: no query provided',
            exitCode: 1,
          };
        }

        const validation = validateReadOnly(rawQuery);
        if (!validation.valid) {
          return {
            stdout: '',
            stderr: `sql validate: ${validation.error}`,
            exitCode: 1,
          };
        }

        const query = adapter.format(rawQuery);
        const store = metaStore.getStore();
        if (store) store.value = { formattedSql: query };

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
  });
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

  const metaStore: MetaStore = new AsyncLocalStorage();
  const sqlCommand = createSqlCommand(adapter, metaStore);

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

  const { sandbox, tools } = await createBashTool({
    sandbox: bashInstance,
    destination: '/',
    extraInstructions:
      'Every bash tool call must include a brief non-empty "reasoning" input explaining why the command is needed.',
    onBeforeBashCall: ({ command }) => {
      console.log(chalk.cyan(`[onBeforeBashCall]: ${command}`));
      return { command };
    },
    onAfterBashCall: ({ result }) => {
      if (result.exitCode !== 0) {
        console.log(chalk.yellow(`[onAfterBashCall]: ${result.exitCode}`));
      }
      return { result };
    },
  });

  const bash = tool({
    ...(tools as any).bash,
    inputSchema: z.object({
      command: z.string().describe('The bash command to execute'),
      reasoning: z
        .string()
        .trim()
        .describe('Brief reason for executing this command'),
    }),
    execute: async ({ command }, execOptions) => {
      const execute = tools.bash.execute;
      if (!execute) {
        throw new Error('bash tool execution is not available');
      }
      return metaStore.run({}, async () => {
        const result = await execute({ command }, execOptions);
        const meta = metaStore.getStore()?.value;
        return meta ? { ...result, meta } : result;
      });
    },
    toModelOutput: ({ output }) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { meta, ...rest } = output as Record<string, unknown>;
      return { type: 'json' as const, value: rest };
    },
  });

  return {
    sandbox,
    tools: {
      ...tools,
      bash,
    },
  };
}
