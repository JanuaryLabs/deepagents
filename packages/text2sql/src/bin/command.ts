import * as path from 'node:path';
import type { Writable } from 'node:stream';

import type { Adapter } from '../lib/adapters/adapter.ts';

export interface ExecutionContext {
  adapters: Record<string, Adapter>;
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

  protected requireAdapter(
    adapters: Record<string, Adapter>,
    db: string | undefined,
  ): Adapter {
    const available = Object.keys(adapters).join(', ') || '(none configured)';
    if (!db) {
      this.fail(
        `missing database name. Usage: sql ${this.name} ${this.usage}. Available: ${available}`,
      );
    }
    const adapter = adapters[db];
    if (!adapter) {
      this.fail(`unknown database "${db}". Available: ${available}`);
    }
    return adapter;
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
    const adapter = this.requireAdapter(ctx.adapters, db);
    const sql = (sqlParts ?? []).join(' ').trim();
    if (!sql) this.fail('no query provided');
    const formatted = await this.formatAndValidate(adapter, sql);
    return this.afterValidation(ctx, adapter, formatted, options);
  }

  private async formatAndValidate(
    adapter: Adapter,
    sql: string,
  ): Promise<string> {
    let formatted: string;
    try {
      formatted = adapter.format(sql);
    } catch (error) {
      this.fail(errorMessage(error));
    }
    try {
      const syntaxError = await adapter.validate(formatted);
      if (syntaxError) this.fail(syntaxError);
    } catch (error) {
      this.fail(errorMessage(error));
    }
    return formatted;
  }

  protected abstract afterValidation(
    ctx: ExecutionContext,
    adapter: Adapter,
    sql: string,
    options: Record<string, unknown>,
  ): Promise<number>;
}
