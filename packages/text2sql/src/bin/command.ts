import type { Adapter } from '../lib/adapters/adapter.ts';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecutionContext {
  adapters: Record<string, Adapter>;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SqlCommandOption {
  flag: string;
  description: string;
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

  toResult(): CommandResult {
    return {
      stdout: '',
      stderr: `sql ${this.command}: ${this.message}\n`,
      exitCode: this.exitCode,
    };
  }
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
  ): Promise<CommandResult>;

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
  ): Promise<CommandResult> {
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
  ): Promise<CommandResult>;
}
