import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { v7 } from 'uuid';

import type { Adapter } from '../../lib/adapters/adapter.ts';
import {
  type CommandResult,
  type ExecutionContext,
  SqlQueryCommand,
  errorMessage,
} from '../command.ts';

export class RunCommand extends SqlQueryCommand {
  readonly name = 'run';
  readonly description = 'Execute query against <db> and store results';
  readonly usage = '<db> "SELECT ..." [--out-dir <path>]';
  override readonly helpDisplay = '<db> "SELECT ..."';
  override readonly options = [
    {
      flag: '--out-dir <path>',
      description:
        'Directory for `sql run` result files (default: $TEXT2SQL_OUT_DIR or ./sql)',
    },
  ];

  protected async afterValidation(
    ctx: ExecutionContext,
    adapter: Adapter,
    sql: string,
    options: Record<string, unknown>,
  ): Promise<CommandResult> {
    const outputDir = this.resolveOutputDir(ctx, options);

    let rows: unknown;
    try {
      rows = await adapter.execute(sql);
    } catch (error) {
      this.fail(errorMessage(error));
    }

    if (!Array.isArray(rows)) {
      this.fail('adapter.execute must return an array of rows');
    }

    const outPath = path.join(outputDir, `${v7()}.json`);
    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(outPath, JSON.stringify(rows, null, 2));
    } catch (error) {
      this.fail(errorMessage(error));
    }

    const columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
    return {
      stdout:
        [
          `results stored in ${outPath}`,
          `columns: ${columns.join(', ') || '(none)'}`,
          `rows: ${rows.length}`,
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private resolveOutputDir(
    ctx: ExecutionContext,
    options: Record<string, unknown>,
  ): string {
    const explicit =
      typeof options.outDir === 'string' ? options.outDir : undefined;
    return path.resolve(
      ctx.cwd,
      explicit ?? ctx.env.TEXT2SQL_OUT_DIR ?? './sql',
    );
  }
}
