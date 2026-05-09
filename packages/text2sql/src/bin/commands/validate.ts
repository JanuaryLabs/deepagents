import { type CommandResult, SqlQueryCommand } from '../command.ts';

export class ValidateCommand extends SqlQueryCommand {
  readonly name = 'validate';
  readonly description = 'Validate query syntax against <db>';
  readonly usage = '<db> "SELECT ..."';
  override readonly helpDisplay = '<db> "SELECT ..."';

  protected async afterValidation(): Promise<CommandResult> {
    return { stdout: 'valid\n', stderr: '', exitCode: 0 };
  }
}
