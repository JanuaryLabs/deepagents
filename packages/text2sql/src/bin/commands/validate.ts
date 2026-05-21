import { type ExecutionContext, SqlQueryCommand } from '../command.ts';

export class ValidateCommand extends SqlQueryCommand {
  readonly name = 'validate';
  readonly description = 'Validate query syntax against <db>';
  readonly usage = '<db> "SELECT ..."';
  override readonly helpDisplay = '<db> "SELECT ..."';

  protected async runQuery(
    ctx: ExecutionContext,
    name: string,
    sql: string,
  ): Promise<number> {
    await ctx.text2Sql.validate(name, sql);
    ctx.stdout.write('valid\n');
    return 0;
  }
}
