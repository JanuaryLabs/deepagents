import type { CommandResult } from 'bash-tool';
import type { Command, CommandContext, ExecResult } from 'just-bash';
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import { v7 } from 'uuid';

import {
  BashException,
  buildSubcommandRepair,
  defineSubcommandGroup,
  repairQuotedArg,
  useBashMeta,
} from '@deepagents/context';

import { resolveAdapter } from './resolve-adapter.ts';
import { Text2Sql, Text2SqlValidationError } from './sql.ts';

const SQL_VALIDATE_REMINDER =
  'Always run `sql validate <db> "..."` before `sql run <db> "..."` to catch syntax errors early.';

class SqlCommandError extends BashException {
  readonly #subcommand: string;
  readonly #exitCode: number;

  constructor(subcommand: string, message: string, exitCode = 1) {
    super(message);
    this.name = 'SqlCommandError';
    this.#subcommand = subcommand;
    this.#exitCode = exitCode;
  }

  format(): CommandResult {
    return {
      stdout: '',
      stderr: `sql ${this.#subcommand}: ${this.message}\n`,
      exitCode: this.#exitCode,
    };
  }
}

export interface CreateSqlCommandOptions {
  /**
   * Default directory for `sql run` artifacts when no `--out-dir` is passed
   * and `$TEXT2SQL_OUT_DIR` is unset. Defaults to `/sql`.
   */
  outputDir?: string;
}

export interface CreateSqlCommandResult {
  command: Command;
  repair: (raw: string) => string;
}

/**
 * Wrap a {@link Text2Sql} instance as a just-bash custom command, exposing
 * `sql run` and `sql validate` inside any sandbox that accepts
 * `customCommands` (e.g. `createVirtualSandbox`). Argv matches the standalone
 * `sql` CLI exactly, so prompts written against one work against the other.
 *
 * Bootstrap (schema indexing) is intentionally **not** exposed as a
 * subcommand here — callers running an in-process sandbox should invoke
 * `text2Sql.index()` directly on the host before constructing the sandbox.
 *
 * @example
 * ```ts
 * const text2Sql = new Text2Sql({
 *   adapters: { pagila },
 *   lock: new FileIndexLock(),
 * });
 * const { command } = createSqlCommand(text2Sql);
 * const sandbox = await createVirtualSandbox({
 *   fs: new InMemoryFs(),
 *   customCommands: [command],
 * });
 * await sandbox.executeCommand('sql run pagila "SELECT 1"');
 * ```
 */
export function createSqlCommand(
  text2Sql: Text2Sql,
  options: CreateSqlCommandOptions = {},
): CreateSqlCommandResult {
  const defaultOutputDir = options.outputDir ?? '/sql';

  const subcommands = {
    run: {
      usage: 'run <db> "SELECT ..."',
      description: 'Execute query against <db> and store results',
      repair: repairDbNameAndQuotedArg,
      handler: (args: string[], ctx: CommandContext) =>
        handleRun(text2Sql, defaultOutputDir, args, ctx),
    },
    validate: {
      usage: 'validate <db> "SELECT ..."',
      description: 'Validate query syntax against <db>',
      repair: repairDbNameAndQuotedArg,
      handler: (args: string[]) => handleValidate(text2Sql, args),
    },
  };

  return {
    command: defineSubcommandGroup('sql', subcommands),
    repair: buildSubcommandRepair('sql', subcommands),
  };
}

interface ParsedFlags {
  positional: string[];
  outDir?: string;
}

function parseFlags(subcommand: string, args: string[]): ParsedFlags {
  try {
    const parsed = parseArgs({
      args,
      options: { 'out-dir': { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
    return {
      positional: parsed.positionals,
      outDir: parsed.values['out-dir'],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SqlCommandError(subcommand, message);
  }
}

function resolveOutputDir(
  ctx: CommandContext,
  flags: ParsedFlags,
  fallback: string,
): string {
  const envOutDir = ctx.env.get('TEXT2SQL_OUT_DIR');
  const candidate = flags.outDir ?? envOutDir ?? fallback;
  return posix.isAbsolute(candidate)
    ? candidate
    : posix.resolve(ctx.cwd, candidate);
}

async function handleRun(
  text2Sql: Text2Sql,
  defaultOutputDir: string,
  args: string[],
  ctx: CommandContext,
): Promise<ExecResult> {
  return runHandler('run', async () => {
    const flags = parseFlags('run', args);
    const meta = useBashMeta();
    meta?.setReminder(SQL_VALIDATE_REMINDER);

    const { name, sql } = takeDbAndSql('run', flags.positional, text2Sql);
    const outputDir = resolveOutputDir(ctx, flags, defaultOutputDir);
    const { rows, columns } = await text2Sql.run(name, sql);

    const outPath = posix.join(outputDir, `${v7()}.json`);
    await ctx.fs.mkdir(outputDir, { recursive: true });
    await ctx.fs.writeFile(outPath, JSON.stringify(rows, null, 2));

    return {
      stdout:
        `results stored in ${outPath}\n` +
        `columns: ${columns.join(', ') || '(none)'}\n` +
        `rows: ${rows.length}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}

async function handleValidate(
  text2Sql: Text2Sql,
  args: string[],
): Promise<ExecResult> {
  return runHandler('validate', async () => {
    const flags = parseFlags('validate', args);
    const { name, sql } = takeDbAndSql('validate', flags.positional, text2Sql);
    await text2Sql.validate(name, sql);
    return { stdout: 'valid\n', stderr: '', exitCode: 0 };
  });
}

async function runHandler(
  subcommand: string,
  fn: () => Promise<ExecResult>,
): Promise<ExecResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BashException) return error.format();
    if (Text2SqlValidationError.isInstance(error)) {
      return new SqlCommandError(subcommand, error.message).format();
    }
    const message = error instanceof Error ? error.message : String(error);
    return new SqlCommandError(subcommand, message).format();
  }
}

function takeDbAndSql(
  subcommand: string,
  positional: string[],
  text2Sql: Text2Sql,
): { name: string; sql: string } {
  const [db, ...rest] = positional;
  if (!db) {
    const available = text2Sql.adapterNames().join(', ');
    throw new SqlCommandError(
      subcommand,
      `missing database name. Usage: sql ${subcommand} <db> "SELECT ...". Available: ${available}`,
    );
  }

  const name = resolveAdapter(text2Sql, db);

  const sql = rest.join(' ').trim();
  if (!sql) {
    throw new SqlCommandError(subcommand, 'no query provided');
  }
  return { name, sql };
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
