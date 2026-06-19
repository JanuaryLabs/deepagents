import * as path from 'node:path';
import type { Writable } from 'node:stream';

import { resolveAdapter } from '../lib/resolve-adapter.ts';
import { Text2Sql, Text2SqlValidationError } from '../lib/sql.ts';

export interface ExecutionContext {
  text2Sql: Text2Sql;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Writable;
  stderr: Writable;
}

export interface SqlCommandOption {
  flag: string;
  description: string;
}

export const OUT_DIR_OPTION: SqlCommandOption = {
  flag: '--out-dir <path>',
  description: 'Output directory (default: $TEXT2SQL_OUT_DIR or ./sql)',
};

export function resolveOutputDir(
  ctx: ExecutionContext,
  options: Record<string, unknown>,
): string {
  const explicit =
    typeof options.outDir === 'string' ? options.outDir : undefined;
  return path.resolve(ctx.cwd, explicit ?? ctx.env.TEXT2SQL_OUT_DIR ?? './sql');
}

export class CommandError extends Error {
  public readonly command: string;
  public readonly exitCode: number;
  constructor(command: string, message: string, exitCode = 1) {
    super(message);
    this.name = 'CommandError';
    this.command = command;
    this.exitCode = exitCode;
  }
}

export function renderCommandError(
  error: CommandError,
  stderr: Writable,
): void {
  stderr.write(`sql ${error.command}: ${error.message}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export abstract class SqlCommand {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly args: string;
  abstract readonly usage: string;
  readonly options: readonly SqlCommandOption[] = [];
  readonly helpDisplay?: string;

  abstract execute(
    ctx: ExecutionContext,
    args: unknown[],
    options: Record<string, unknown>,
  ): Promise<number>;

  protected fail(message: string, exitCode = 1): never {
    throw new CommandError(this.name, message, exitCode);
  }

  protected resolveAdapterName(
    text2Sql: Text2Sql,
    db: string | undefined,
  ): string {
    if (!db) {
      const available =
        text2Sql.adapterNames().join(', ') || '(none configured)';
      this.fail(
        `missing database name. Usage: sql ${this.name} ${this.usage}. Available: ${available}`,
      );
    }
    try {
      return resolveAdapter(text2Sql, db);
    } catch (error) {
      this.fail(errorMessage(error));
    }
  }
}

export abstract class SqlQueryCommand extends SqlCommand {
  readonly args = '<db> <...sql>';

  async execute(
    ctx: ExecutionContext,
    args: unknown[],
    options: Record<string, unknown>,
  ): Promise<number> {
    const [db, sqlParts] = args as [string | undefined, string[] | undefined];
    const name = this.resolveAdapterName(ctx.text2Sql, db);
    const sql = (sqlParts ?? []).join(' ').trim();
    if (!sql) this.fail('no query provided');

    try {
      return await this.runQuery(ctx, name, sql, options);
    } catch (error) {
      if (error instanceof CommandError) throw error;
      if (Text2SqlValidationError.isInstance(error)) this.fail(error.message);
      this.fail(errorMessage(error));
    }
  }

  protected abstract runQuery(
    ctx: ExecutionContext,
    name: string,
    sql: string,
    options: Record<string, unknown>,
  ): Promise<number>;
}
