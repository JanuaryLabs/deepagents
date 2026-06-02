#!/usr/bin/env node
import { cac } from 'cac';
import { JSONRPCClient, JSONRPCErrorException } from 'json-rpc-2.0';
import * as path from 'node:path';
import { v7 } from 'uuid';

const DAEMON_URL =
  process.env.TEXT2SQL_DAEMON_URL ?? 'http://127.0.0.1:4747/rpc';

const OUT_DIR_OPTION = {
  flag: '--out-dir <path>',
  description: 'Output directory (default: $TEXT2SQL_OUT_DIR or ./sql)',
} as const;

function resolveOutputDir(options: Record<string, unknown>): string {
  const explicit =
    typeof options.outDir === 'string' ? options.outDir : undefined;
  return path.resolve(
    process.cwd(),
    explicit ?? process.env.TEXT2SQL_OUT_DIR ?? './sql',
  );
}

class ShimError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'ShimError';
    this.exitCode = exitCode;
  }
}

function fail(message: string, exitCode = 1): never {
  throw new ShimError(message, exitCode);
}

const client = new JSONRPCClient(async (jsonRPCRequest) => {
  let response: Response;
  try {
    response = await fetch(DAEMON_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(jsonRPCRequest),
    });
  } catch (cause) {
    fail(
      `daemon unreachable at ${DAEMON_URL}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    fail(`daemon http ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  if (text.length === 0) {
    fail(
      `daemon returned empty body (status ${response.status}) for request with id ${String(jsonRPCRequest.id)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`daemon returned non-JSON body: ${text.slice(0, 200)}`);
  }
  client.receive(body as never);
});

async function rpc<T>(method: string, params?: unknown): Promise<T> {
  try {
    return (await client.request(method, params)) as T;
  } catch (error) {
    if (error instanceof JSONRPCErrorException) fail(error.message);
    throw error;
  }
}

interface RunResult {
  rows: unknown[];
  columns: string[];
}

interface IndexResult {
  fragments: unknown[];
  resolvedNames: string[];
  events?: unknown[];
}

async function runCommand(
  db: string,
  sqlParts: string[],
  options: Record<string, unknown>,
): Promise<number> {
  const sql = sqlParts.join(' ').trim();
  if (!sql) fail('no query provided');

  const result = await rpc<RunResult>('text2sql.run', { db, sql });

  const { mkdir, writeFile } = await import('node:fs/promises');

  const outputDir = resolveOutputDir(options);
  const outPath = path.join(outputDir, `${v7()}.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(result.rows, null, 2));

  process.stdout.write(`results stored in ${outPath}\n`);
  process.stdout.write(`columns: ${result.columns.join(', ') || '(none)'}\n`);
  process.stdout.write(`rows: ${result.rows.length}\n`);
  return 0;
}

async function validateCommand(
  db: string,
  sqlParts: string[],
): Promise<number> {
  const sql = sqlParts.join(' ').trim();
  if (!sql) fail('no query provided');
  await rpc<{ sql: string }>('text2sql.validate', { db, sql });
  process.stdout.write('valid\n');
  return 0;
}

async function indexCommand(
  names: string[],
  options: Record<string, unknown>,
): Promise<number> {
  const verbose = resolveVerbose(options.verbose);
  const params: Record<string, unknown> = {};
  if (names.length > 0) params.names = names;
  if (verbose) params.emitEvents = true;

  const result = await rpc<IndexResult>('text2sql.index', params);

  const { mkdir, writeFile } = await import('node:fs/promises');

  const outputDir = resolveOutputDir(options);
  const id = v7();
  const fragmentsPath = path.join(outputDir, `index-${id}.json`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(fragmentsPath, JSON.stringify(result.fragments, null, 2));

  let eventsPath: string | null = null;
  if (result.events && result.events.length > 0) {
    eventsPath = path.join(outputDir, `index-${id}.events.ndjson`);
    const ndjson =
      result.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(eventsPath, ndjson);
    if (verbose === 'json') process.stderr.write(ndjson);
  }

  const manifest = {
    fragmentsPath,
    eventsPath,
    adapters: result.resolvedNames,
    fragments: result.fragments.length,
  };
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  return 0;
}

function resolveVerbose(value: unknown): 'json' | null {
  if (value === undefined || value === false) return null;
  if (value === true || value === '' || value === 'json') return 'json';
  fail(`invalid --verbose value "${String(value)}". Expected "json".`);
}

const HELP_DISPLAY: Record<string, string> = {
  'run <db> [...sql]': 'run <db> "SELECT ..."',
  'validate <db> [...sql]': 'validate <db> "SELECT ..."',
  'index [...adapters]': 'index [adapter ...]',
};

const cli = cac('sql');

cli
  .usage('<run|validate|index> ...')
  .help((sections) =>
    sections.map((section) =>
      section.title === 'Commands'
        ? { ...section, body: rewriteCommandsHelp(section.body) }
        : section,
    ),
  );

cli
  .command('run <db> [...sql]', 'Execute query against <db>')
  .option(OUT_DIR_OPTION.flag, OUT_DIR_OPTION.description)
  .action(
    (db: string, sqlParts: string[] = [], options: Record<string, unknown>) =>
      runCommand(db, sqlParts, options),
  );

cli
  .command('validate <db> [...sql]', 'Validate query syntax against <db>')
  .action((db: string, sqlParts: string[] = []) =>
    validateCommand(db, sqlParts),
  );

cli
  .command('index [...adapters]', 'Index adapter schemas')
  .option('-v, --verbose [format]', 'Emit progress events to stderr (json)')
  .option(OUT_DIR_OPTION.flag, OUT_DIR_OPTION.description)
  .action((adapters: string[] = [], options: Record<string, unknown>) =>
    indexCommand(adapters, options),
  );

function rewriteCommandsHelp(body: string): string {
  return Object.entries(HELP_DISPLAY).reduce(
    (current, [from, to]) => current.replace(from, to),
    body,
  );
}

process.exitCode = await runCli();

async function runCli(): Promise<number> {
  try {
    cli.parse(process.argv, { run: false });

    if (cli.options.help) return 0;

    if (!cli.matchedCommand) {
      try {
        cli.globalCommand.checkUnknownOptions();
        cli.globalCommand.checkOptionValue();
      } catch (error) {
        return writeCliError(error);
      }
      const [subcommand] = cli.args;
      const label = subcommand
        ? `unknown subcommand "${String(subcommand)}"`
        : 'missing subcommand';
      process.stderr.write(`sql: ${label}\n`);
      cli.outputHelp();
      return 2;
    }

    const result = await cli.runMatchedCommand();
    return typeof result === 'number' ? result : 0;
  } catch (error) {
    return writeCliError(error);
  }
}

function writeCliError(error: unknown): number {
  if (error instanceof ShimError) {
    process.stderr.write(`sql: ${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof Error && error.name === 'CACError') {
    process.stderr.write(`sql: ${error.message}\n`);
    cli.outputHelp();
    return 2;
  }
  process.stderr.write(
    `sql: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  return 1;
}
