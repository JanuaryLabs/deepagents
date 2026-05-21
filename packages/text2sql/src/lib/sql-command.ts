import type { Command, CommandContext, ExecResult } from 'just-bash';
import { posix } from 'node:path';
import { parseArgs } from 'node:util';
import { v7 } from 'uuid';

import {
  buildSubcommandRepair,
  defineSubcommandGroup,
  repairQuotedArg,
  useBashMeta,
} from '@deepagents/context';

import {
  Text2Sql,
  Text2SqlUnknownAdapterError,
  Text2SqlValidationError,
} from './sql.ts';

const SQL_VALIDATE_REMINDER =
  'Always run `sql validate <db> "..."` before `sql run <db> "..."` to catch syntax errors early.';

class SqlCommandError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'SqlCommandError';
    this.exitCode = exitCode;
  }
}

export interface CreateSqlCommandOptions {
  /**
   * Default directory for `sql run` / `sql index` artifacts when no `--out-dir`
   * is passed and `$TEXT2SQL_OUT_DIR` is unset. Defaults to `/sql`.
   */
  outputDir?: string;
}

export interface CreateSqlCommandResult {
  command: Command;
  repair: (raw: string) => string;
}

/**
 * Wrap a {@link Text2Sql} instance as a just-bash custom command, exposing
 * `sql run`, `sql validate`, and `sql index` inside any sandbox that accepts
 * `customCommands` (e.g. `createVirtualSandbox`). Argv matches the standalone
 * `sql` CLI exactly, so prompts written against one work against the other.
 *
 * @example
 * ```ts
 * const text2Sql = new Text2Sql({ adapters: { pagila } });
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
    index: {
      usage: 'index [adapter ...]',
      description: 'Index adapter schemas and write context artifacts',
      handler: (args: string[], ctx: CommandContext) =>
        handleIndex(text2Sql, defaultOutputDir, args, ctx),
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
  all: boolean;
}

function parseFlags(args: string[]): ParsedFlags {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        'out-dir': { type: 'string' };
        all: { type: 'boolean' };
      };
      args: string[];
      allowPositionals: true;
    }>
  >;
  try {
    parsed = parseArgs({
      args,
      options: {
        'out-dir': { type: 'string' },
        all: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SqlCommandError(message, 1);
  }
  return {
    positional: parsed.positionals,
    outDir: parsed.values['out-dir'],
    all: parsed.values.all === true,
  };
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
    const flags = parseFlags(args);
    const meta = useBashMeta();
    meta?.setReminder(SQL_VALIDATE_REMINDER);

    const { name, sql } = takeDbAndSql(flags.positional, 'run', text2Sql);
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
    const flags = parseFlags(args);
    const { name, sql } = takeDbAndSql(flags.positional, 'validate', text2Sql);
    await text2Sql.validate(name, sql);
    return { stdout: 'valid\n', stderr: '', exitCode: 0 };
  });
}

interface IndexManifest {
  fragmentsPath: string;
  eventsPath: string | null;
  adapters: string[];
  fragments: number;
}

async function handleIndex(
  text2Sql: Text2Sql,
  defaultOutputDir: string,
  args: string[],
  ctx: CommandContext,
): Promise<ExecResult> {
  return runHandler('index', async () => {
    const flags = parseFlags(args);
    const available = text2Sql.adapterNames();
    const requested = flags.all ? [] : dedupe(flags.positional);
    const names = requested.length === 0 ? available : requested;

    for (const name of names) {
      if (!text2Sql.hasAdapter(name)) {
        throw new SqlCommandError(
          `unknown adapter "${name}". Available: ${available.join(', ')}`,
          1,
        );
      }
    }

    const outputDir = resolveOutputDir(ctx, flags, defaultOutputDir);
    const fragments = await text2Sql.index({ names });

    const fragmentsPath = posix.join(outputDir, `index-${v7()}.json`);
    await ctx.fs.mkdir(outputDir, { recursive: true });
    await ctx.fs.writeFile(fragmentsPath, JSON.stringify(fragments, null, 2));

    const manifest: IndexManifest = {
      fragmentsPath,
      eventsPath: null,
      adapters: names,
      fragments: countSchemaFragments(fragments),
    };
    return {
      stdout: JSON.stringify(manifest, null, 2) + '\n',
      stderr: '',
      exitCode: 0,
    };
  });
}

async function runHandler(
  name: string,
  fn: () => Promise<ExecResult>,
): Promise<ExecResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SqlCommandError) {
      return {
        stdout: '',
        stderr: `sql ${name}: ${error.message}\n`,
        exitCode: error.exitCode,
      };
    }
    if (
      Text2SqlValidationError.isInstance(error) ||
      Text2SqlUnknownAdapterError.isInstance(error)
    ) {
      return {
        stdout: '',
        stderr: `sql ${name}: ${error.message}\n`,
        exitCode: 1,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `sql ${name}: ${message}\n`, exitCode: 1 };
  }
}

function takeDbAndSql(
  positional: string[],
  cmd: string,
  text2Sql: Text2Sql,
): { name: string; sql: string } {
  const [db, ...rest] = positional;
  const available = text2Sql.adapterNames().join(', ');
  if (!db) {
    throw new SqlCommandError(
      `missing database name. Usage: sql ${cmd} <db> "SELECT ...". Available: ${available}`,
      1,
    );
  }
  if (!text2Sql.hasAdapter(db)) {
    throw new SqlCommandError(
      `unknown database "${db}". Available: ${available}`,
      1,
    );
  }
  const sql = rest.join(' ').trim();
  if (!sql) {
    throw new SqlCommandError('no query provided', 1);
  }
  return { name: db, sql };
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

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function countSchemaFragments(
  fragments: ReadonlyArray<{ data?: unknown }>,
): number {
  return fragments.reduce((count, adapterFragment) => {
    return Array.isArray(adapterFragment.data)
      ? count + adapterFragment.data.length
      : count + 1;
  }, 0);
}
