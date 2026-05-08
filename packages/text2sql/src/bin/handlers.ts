import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { v7 } from 'uuid';

import type { Adapter } from '../lib/adapters/adapter.ts';

const OUTPUT_DIR = './sql';
const OUTPUT_LABEL = './sql';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  adapters: Record<string, Adapter>,
  db: string | undefined,
  rawSql: string,
): Promise<CommandResult> {
  const resolved = resolveAdapter(adapters, db, rawSql, 'run');
  if ('error' in resolved) return resolved.error;
  const { adapter, sql } = resolved;

  const formatted = adapter.format(sql);

  const syntaxError = await adapter.validate(formatted);
  if (syntaxError) {
    return { stdout: '', stderr: `sql run: ${syntaxError}`, exitCode: 1 };
  }

  let rows: unknown;
  try {
    rows = await adapter.execute(formatted);
  } catch (error) {
    return {
      stdout: '',
      stderr: `sql run: ${errorMessage(error)}`,
      exitCode: 1,
    };
  }

  if (!Array.isArray(rows)) {
    return {
      stdout: '',
      stderr: 'sql run: adapter.execute must return an array of rows',
      exitCode: 1,
    };
  }

  const filename = `${v7()}.json`;
  const outPath = path.join(OUTPUT_DIR, filename);
  const outputLabel = `${OUTPUT_LABEL}/${filename}`;
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify(rows, null, 2));

  const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];

  return {
    stdout:
      [
        `results stored in ${outputLabel}`,
        `columns: ${columns.join(', ') || '(none)'}`,
        `rows: ${rows.length}`,
      ].join('\n') + '\n',
    stderr: '',
    exitCode: 0,
  };
}

export async function validateCommand(
  adapters: Record<string, Adapter>,
  db: string | undefined,
  rawSql: string,
): Promise<CommandResult> {
  const resolved = resolveAdapter(adapters, db, rawSql, 'validate');
  if ('error' in resolved) return resolved.error;
  const { adapter, sql } = resolved;

  const formatted = adapter.format(sql);

  const syntaxError = await adapter.validate(formatted);
  if (syntaxError) {
    return { stdout: '', stderr: `sql validate: ${syntaxError}`, exitCode: 1 };
  }

  return { stdout: 'valid\n', stderr: '', exitCode: 0 };
}

type Resolved = { adapter: Adapter; sql: string } | { error: CommandResult };

function resolveAdapter(
  adapters: Record<string, Adapter>,
  db: string | undefined,
  rawSql: string,
  subcommand: 'run' | 'validate',
): Resolved {
  const available = Object.keys(adapters).join(', ') || '(none configured)';

  if (!db) {
    return {
      error: {
        stdout: '',
        stderr: `sql ${subcommand}: missing database name. Usage: sql ${subcommand} <db> "SELECT ...". Available: ${available}`,
        exitCode: 1,
      },
    };
  }

  const adapter = adapters[db];
  if (!adapter) {
    return {
      error: {
        stdout: '',
        stderr: `sql ${subcommand}: unknown database "${db}". Available: ${available}`,
        exitCode: 1,
      },
    };
  }

  const sql = rawSql.trim();
  if (!sql) {
    return {
      error: {
        stdout: '',
        stderr: `sql ${subcommand}: no query provided`,
        exitCode: 1,
      },
    };
  }

  return { adapter, sql };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
