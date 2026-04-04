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
  parse,
} from 'just-bash';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { v7 } from 'uuid';
import z from 'zod';

import type { SkillPathMapping } from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';
import {
  SqlBacktickRewritePlugin,
  SqlProxyEnforcementPlugin,
  SqlProxyViolationError,
} from './sql-transform-plugins.ts';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SubcommandDefinition {
  usage: string;
  description: string;
  repair?: (rawArgs: string) => string | null;
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

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRepair(
  name: string,
  subcommands: Record<string, SubcommandDefinition>,
) {
  const subNames = Object.keys(subcommands).map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `^(\\s*${escapeRegExp(name)}\\s+(?:${subNames}))\\s+([\\s\\S]+)$`,
  );

  return function repair(raw: string): string {
    const match = raw.match(pattern);
    if (!match) return raw;

    try {
      parse(raw);
      return raw;
    } catch {
      // fall through to repair
    }

    const [, prefix, argsPart] = match;
    const sub = prefix.trim().split(/\s+/).pop()!;
    const repairFn = subcommands[sub]?.repair;
    if (!repairFn) return raw;

    const repairedArgs = repairFn(argsPart);
    if (repairedArgs == null) return raw;

    const repaired = `${prefix} ${repairedArgs}`;
    try {
      parse(repaired);
      return repaired;
    } catch {
      return raw;
    }
  };
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

const SQL_VALIDATE_REMINDER =
  'Always run `sql validate` before `sql run` to catch syntax errors early.';

function normalizeShellArtifacts(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\([().*])/g, '$1')
    .replace(/\\(?=$)/gm, '');
}

function stripQuoteArtifacts(raw: string): string {
  let sql = raw.trim();
  if (sql.startsWith('"')) {
    sql = sql.slice(1);
    if (sql.endsWith('"')) sql = sql.slice(0, -1);
  } else if (sql.startsWith("'")) {
    sql = sql.slice(1);
    if (sql.endsWith("'")) sql = sql.slice(0, -1);
  }
  return sql.trim();
}

function repairSqlArgs(rawArgs: string): string | null {
  const sql = stripQuoteArtifacts(rawArgs);
  if (!sql) return null;
  const escaped = sql.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

function createSqlCommand(adapter: Adapter, metaStore: MetaStore) {
  const subcommands = {
    run: {
      usage: 'run "SELECT ..."',
      description: 'Execute query and store results',
      repair: repairSqlArgs,
      handler: async (args, ctx) => {
        const store = metaStore.getStore();
        if (store) {
          store.value = { ...store.value, reminder: SQL_VALIDATE_REMINDER };
        }

        const rawQuery = normalizeShellArtifacts(args.join(' ').trim());

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
        if (store) {
          store.value = { ...store.value, formattedSql: query };
        }

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
      repair: repairSqlArgs,
      handler: async (args) => {
        const rawQuery = normalizeShellArtifacts(args.join(' ').trim());

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
        if (store) store.value = { ...store.value, formattedSql: query };

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

  const command = createCommand('sql', subcommands);
  const repair = buildRepair('sql', subcommands);
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

function toViolationResult(error: unknown): CommandResult | null {
  if (error instanceof SqlProxyViolationError) {
    return { stdout: '', stderr: `${error.message}\n`, exitCode: 1 };
  }
  return null;
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
  const { command: sqlCommand, repair: repairCommand } = createSqlCommand(
    adapter,
    metaStore,
  );

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

  const { sandbox, tools } = await createBashTool({
    sandbox: bashInstance,
    destination: '/',
    extraInstructions:
      'Every bash tool call must include a brief non-empty "reasoning" input explaining why the command is needed.',
    onBeforeBashCall: ({ command }) => {
      const repaired = repairCommand(command);
      console.log(chalk.cyan(`[onBeforeBashCall]: ${repaired}`));
      return { command: repaired };
    },
    onAfterBashCall: ({ result }) => {
      if (result.exitCode !== 0) {
        console.log(chalk.yellow(`[onAfterBashCall]: ${result.exitCode}`));
      }
      return { result };
    },
  });

  const guardedSandbox = {
    ...sandbox,
    executeCommand: async (command: string) => {
      try {
        return await sandbox.executeCommand(command);
      } catch (error) {
        const violation = toViolationResult(error);
        if (violation) return violation;
        throw error;
      }
    },
  };

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
        try {
          const result = await execute({ command }, execOptions);
          const storeValue = metaStore.getStore()?.value;
          if (!storeValue) return result;

          const { reminder, ...meta } = storeValue;
          return { ...result, meta, reminder };
        } catch (error) {
          const violation = toViolationResult(error);
          if (violation) return violation;
          throw error;
        }
      });
    },
    toModelOutput: ({ output }) => {
      if (typeof output !== 'object' || output === null) {
        return { type: 'json' as const, value: output };
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { meta, ...rest } = output as unknown as Record<string, unknown>;
      return { type: 'json' as const, value: rest };
    },
  });

  return {
    sandbox: guardedSandbox,
    tools: {
      ...tools,
      bash,
    },
  };
}
