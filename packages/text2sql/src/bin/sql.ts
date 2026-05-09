#!/usr/bin/env node
import { type CAC, cac } from 'cac';

import {
  CommandError,
  type CommandResult,
  type ExecutionContext,
  type SqlCommand,
  errorMessage,
} from './command.ts';
import { commands } from './commands/registry.ts';
import { loadAdapters } from './load-adapters.ts';

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

for (const command of commands) {
  registerCommand(cli, command);
}

process.exit(await runCli());

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

function registerCommand(cli: CAC, command: SqlCommand): void {
  const cliCommand = cli
    .command(`${command.name} ${command.args}`, command.description)
    .usage(command.usage);

  for (const option of command.options) {
    cliCommand.option(option.flag, option.description);
  }

  cliCommand.action(async (...callArgs: unknown[]) => {
    const options = (callArgs[callArgs.length - 1] ?? {}) as Record<
      string,
      unknown
    >;
    const positional = callArgs.slice(0, -1);
    return runCommand(command, positional, options);
  });
}

async function runCommand(
  command: SqlCommand,
  positional: unknown[],
  options: Record<string, unknown>,
): Promise<number> {
  let ctx: ExecutionContext;
  try {
    ctx = {
      adapters: await loadAdapters(),
      cwd: process.cwd(),
      env: process.env,
    };
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }

  try {
    const result = await command.execute(ctx, positional, options);
    writeCommandResult(result);
    return result.exitCode;
  } catch (error) {
    if (error instanceof CommandError) {
      writeCommandResult(error.toResult());
      return error.exitCode;
    }
    throw error;
  }
}

function rewriteCommandsHelp(body: string): string {
  return commands.reduce((current, command) => {
    if (!command.helpDisplay) return current;
    return current.replace(
      `${command.name} ${command.args}`,
      `${command.name} ${command.helpDisplay}`,
    );
  }, body);
}

function writeCommandResult(result: CommandResult): void {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) {
    const out = result.stderr.endsWith('\n')
      ? result.stderr
      : result.stderr + '\n';
    process.stderr.write(out);
  }
}

function writeCliError(error: unknown): number {
  if (error instanceof Error && error.name === 'CACError') {
    process.stderr.write(`sql: ${error.message}\n`);
    cli.outputHelp();
    return 2;
  }
  if (error instanceof CommandError) {
    writeCommandResult(error.toResult());
    return error.exitCode;
  }
  process.stderr.write(
    `sql: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  return 1;
}
