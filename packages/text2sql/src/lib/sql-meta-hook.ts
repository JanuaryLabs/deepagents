import type { CommandResult } from 'bash-tool';
import type { CommandNode, WordNode } from 'just-bash';
import { parse } from 'just-bash';

import { asStaticWordText, useBashMeta } from '@deepagents/context';

const SQL_VALIDATE_REMINDER =
  'Always run `sql validate <db> "..."` before `sql run <db> "..."` to catch syntax errors early.';

export interface SqlCommandFormatter {
  format(sql: string): string;
}

export interface CreateSqlMetaHookOptions {
  adapters: Record<string, SqlCommandFormatter>;
}

export interface SqlMetaTrackInput {
  repaired: string;
  transformed: string;
}

export interface SqlMetaAfterHookInput {
  command: string;
  result: CommandResult;
}

type SqlQuerySubcommand = 'run' | 'validate';

interface SqlQueryInvocation {
  subcommand: SqlQuerySubcommand;
  dbName: string;
  sql: string;
}

export function createSqlMetaHook({ adapters }: CreateSqlMetaHookOptions) {
  const pendingByCommand = new Map<string, SqlQueryInvocation[]>();

  return {
    track({ repaired, transformed }: SqlMetaTrackInput): void {
      const invocation = parseSqlQueryInvocation(repaired);
      if (!invocation) return;
      const pending = pendingByCommand.get(transformed) ?? [];
      pending.push(invocation);
      pendingByCommand.set(transformed, pending);
    },

    onAfterBashCall({ command }: SqlMetaAfterHookInput) {
      const pending = pendingByCommand.get(command);
      const invocation = pending?.shift();
      if (pending?.length === 0) pendingByCommand.delete(command);
      if (!invocation) return undefined;

      if (invocation.subcommand === 'run') {
        useBashMeta()?.setReminder(SQL_VALIDATE_REMINDER);
      }

      const adapter = adapters[invocation.dbName];
      if (!adapter) return undefined;

      try {
        useBashMeta()?.setHidden({
          formattedSql: adapter.format(invocation.sql),
        });
      } catch {
        // Formatting metadata is best-effort and must not change command output.
      }

      return undefined;
    },
  };
}

function parseSqlQueryInvocation(command: string): SqlQueryInvocation | null {
  const simpleCommand = parseSingleSimpleCommand(command);
  if (!simpleCommand) return null;
  if (asStaticWordText(simpleCommand.name) !== 'sql') return null;
  if (simpleCommand.args.length < 3) return null;

  const subcommand = asStaticWordText(simpleCommand.args[0]);
  if (subcommand !== 'run' && subcommand !== 'validate') return null;

  const dbName = asStaticWordText(simpleCommand.args[1]);
  if (!dbName) return null;

  const sql = joinSqlWords(simpleCommand.args.slice(2));
  if (!sql) return null;

  return { subcommand, dbName, sql };
}

function parseSingleSimpleCommand(
  command: string,
): Extract<CommandNode, { type: 'SimpleCommand' }> | null {
  const normalized = command.trim();
  if (!normalized) return null;

  try {
    const script = parse(normalized);
    if (script.statements.length !== 1) return null;

    const statement = script.statements[0];
    if (
      statement.background ||
      statement.operators.length > 0 ||
      statement.pipelines.length !== 1
    ) {
      return null;
    }

    const pipeline = statement.pipelines[0];
    if (pipeline.negated || pipeline.timed || pipeline.commands.length !== 1) {
      return null;
    }

    const commandNode = pipeline.commands[0];
    if (commandNode.type !== 'SimpleCommand') return null;
    if (
      commandNode.assignments.length > 0 ||
      commandNode.redirections.length > 0 ||
      !commandNode.name
    ) {
      return null;
    }

    return commandNode;
  } catch {
    return null;
  }
}

function joinSqlWords(words: WordNode[]): string | null {
  const values: string[] = [];
  for (const word of words) {
    const value = asStaticWordText(word, {
      preserveLegacyBackticks: true,
    });
    if (value == null) return null;
    values.push(value);
  }
  const sql = values.join(' ').trim();
  return sql || null;
}
