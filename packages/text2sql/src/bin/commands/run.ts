import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { v7 } from 'uuid';

import type { Adapter } from '../../lib/adapters/adapter.ts';
import {
  type ExecutionContext,
  OUT_DIR_OPTION,
  SqlQueryCommand,
  errorMessage,
  resolveOutputDir,
} from '../command.ts';

export class RunCommand extends SqlQueryCommand {
  readonly name = 'run';
  readonly description = 'Execute query against <db> and store results';
  readonly usage = '<db> "SELECT ..." [--out-dir <path>]';
  override readonly helpDisplay = '<db> "SELECT ..."';
  override readonly options = [OUT_DIR_OPTION];

  protected async afterValidation(
    ctx: ExecutionContext,
    adapter: Adapter,
    sql: string,
    options: Record<string, unknown>,
  ): Promise<number> {
    const outputDir = resolveOutputDir(ctx, options);

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
    ctx.stdout.write(`results stored in ${outPath}\n`);
    ctx.stdout.write(`columns: ${columns.join(', ') || '(none)'}\n`);
    ctx.stdout.write(`rows: ${rows.length}\n`);
    return 0;
  }
}
