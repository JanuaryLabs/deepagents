import { createBashTool } from 'bash-tool';
import chalk from 'chalk';
import {
  Bash,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
  defineCommand,
} from 'just-bash';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { Adapter } from '../adapters/adapter.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Command Helper Types & Utilities
// ─────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandContext {
  fs: {
    writeFile: (path: string, content: string) => Promise<void>;
    readFile: (path: string) => Promise<string>;
  };
  cwd: string;
  env: Record<string, string>;
  stdin: string;
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
      return subcommands[subcommand].handler(restArgs, ctx as CommandContext);
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

/**
 * Creates the `sql` command with run/validate subcommands.
 */
function createSqlCommand(adapter: Adapter) {
  return createCommand('sql', {
    run: {
      usage: 'run "SELECT ..."',
      description: 'Execute query and store results',
      handler: async (args, ctx) => {
        const query = args.join(' ').trim();

        if (!query) {
          return {
            stdout: '',
            stderr: 'sql run: no query provided',
            exitCode: 1,
          };
        }

        const validation = validateReadOnly(query);
        if (!validation.valid) {
          return {
            stdout: '',
            stderr: `sql run: ${validation.error}`,
            exitCode: 1,
          };
        }

        try {
          const rows = await adapter.execute(query);
          const rowsArray = Array.isArray(rows) ? rows : [];

          const filePath = `/results/${crypto.randomUUID()}.json`;
          await ctx.fs.writeFile(filePath, JSON.stringify(rowsArray, null, 2));

          const columns =
            rowsArray.length > 0 ? Object.keys(rowsArray[0] as object) : [];

          return {
            stdout:
              [
                filePath,
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
      handler: (args) => {
        const query = args.join(' ').trim();

        if (!query) {
          return {
            stdout: '',
            stderr: 'sql validate: no query provided',
            exitCode: 1,
          };
        }

        const validation = validateReadOnly(query);
        if (!validation.valid) {
          return {
            stdout: '',
            stderr: `sql validate: ${validation.error}`,
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
  /** Chat ID for artifact organization (session-level) */
  chatId: string;
  /** Message ID for turn-level artifact isolation */
  messageId: string;
}

/**
 * Creates bash tool with integrated sql command.
 *
 * The agent sees only one tool: `bash`
 * SQL is executed via: sql run "SELECT ..."
 *
 * Dual-level artifact storage:
 * - `/results/` → `./artifacts/{chatId}/{messageId}/results/` (current turn, write)
 * - `/artifacts/` → `./artifacts/{chatId}/` (all turns, browse previous)
 *
 * @param options - Configuration options
 * @param options.adapter - Database adapter for SQL execution
 * @param options.chatId - Chat ID for session-level organization
 * @param options.messageId - Message ID for turn-level isolation
 */
export async function createResultTools(options: ResultToolsOptions) {
  const { adapter, chatId, messageId } = options;
  const sqlCommand = createSqlCommand(adapter);

  // Artifact directories
  const chatDir = path.join(process.cwd(), 'artifacts', chatId);
  const resultsDir = path.join(chatDir, messageId, 'results');

  await fs.mkdir(resultsDir, { recursive: true });

  // Dual mount: /results for current turn, /artifacts for browsing all turns
  const filesystem = new MountableFs({
    base: new OverlayFs({ root: process.cwd() }),
    mounts: [
      {
        mountPoint: '/results',
        filesystem: new ReadWriteFs({ root: resultsDir }),
      },
      {
        mountPoint: '/artifacts',
        filesystem: new ReadWriteFs({ root: chatDir }),
      },
    ],
  });

  const bashInstance = new Bash({
    customCommands: [sqlCommand],
    fs: filesystem,
  });

  const { bash, sandbox } = await createBashTool({
    sandbox: bashInstance,
    destination: '/',
    uploadDirectory: {
      source: process.cwd(),
      include: 'packages/text2sql/src/skills/**/*.md',
    },
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

  return { bash, sandbox };
}
