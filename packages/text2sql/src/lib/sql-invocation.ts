import type { CommandNode, WordNode } from 'just-bash';
import { parse } from 'just-bash';

import { asStaticWordText } from '@deepagents/context';

export type SqlQuerySubcommand = 'run' | 'validate';

export interface SqlQueryInvocation {
  subcommand: SqlQuerySubcommand;
  dbName: string;
  sql: string;
}

/**
 * Parse a single `sql run|validate <db> "<sql>"` command into its parts, or
 * `null` for anything that is not exactly one such invocation (pipelines,
 * redirections, other commands, unparseable input). Shared by the meta hook
 * (which tracks invocations to attach formatted-SQL metadata) and the
 * validate-before-run reminder predicate.
 */
export function parseSqlQueryInvocation(
  command: string,
): SqlQueryInvocation | null {
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
