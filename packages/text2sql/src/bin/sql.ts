#!/usr/bin/env node
import { runCommand, validateCommand } from './handlers.js';
import { loadAdapters } from './load-adapters.js';

const USAGE = 'Usage: sql <run|validate> <db> "<sql>"';

async function main(): Promise<number> {
  const [subcommand, db, ...sqlParts] = process.argv.slice(2);
  const sql = sqlParts.join(' ');

  if (subcommand !== 'run' && subcommand !== 'validate') {
    process.stderr.write(
      `sql: unknown subcommand "${subcommand ?? ''}". ${USAGE}\n`,
    );
    return 2;
  }

  let adapters;
  try {
    adapters = await loadAdapters();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const result =
    subcommand === 'run'
      ? await runCommand(adapters, db, sql)
      : await validateCommand(adapters, db, sql);

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) {
    const out = result.stderr.endsWith('\n')
      ? result.stderr
      : result.stderr + '\n';
    process.stderr.write(out);
  }
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `sql: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  },
);
