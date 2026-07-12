import { type UIMessage, isToolUIPart } from 'ai';

import { type WhenPredicate, reminder } from '@deepagents/context';

import {
  type SqlQueryInvocation,
  parseSqlQueryInvocation,
} from './sql-invocation.ts';
import { repairSqlCommand } from './sql-repair.ts';

export const SQL_VALIDATE_REMINDER =
  'Always run `sql validate <db> "..."` before `sql run <db> "..."` to catch syntax errors early.';

function extractSqlInvocation(command: unknown): SqlQueryInvocation | null {
  if (typeof command !== 'string') return null;
  return parseSqlQueryInvocation(repairSqlCommand(command));
}

function inputCommand(input: unknown): unknown {
  return (input as { command?: unknown } | undefined)?.command;
}

/**
 * True when a `sql validate` of the same `(db, sql)` appears in the assistant's
 * recent tool history — i.e. the model already validated this exact query. SQL
 * text is compared verbatim; a reformatted query won't match, so the nudge
 * fires again rather than being wrongly suppressed (errs toward reminding).
 */
function alreadyValidated(
  messages: UIMessage[] | undefined,
  run: SqlQueryInvocation,
): boolean {
  for (const message of messages ?? []) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const invocation = extractSqlInvocation(
        inputCommand((part as { input?: unknown }).input),
      );
      if (
        invocation?.subcommand === 'validate' &&
        invocation.dbName === run.dbName &&
        invocation.sql === run.sql
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Fires after a successful `sql run` that was NOT preceded by a `sql validate`
 * of the same query. Reads the terminal call from `ctx.toolOutcome` (only
 * populated at `target: 'tool-output'` time) and scans
 * `ctx.lastAssistantMessages` for a matching prior validate.
 */
export function sqlRunMissingValidate(): WhenPredicate {
  return (ctx) => {
    const call = ctx.toolOutcome;
    if (!call || call.state !== 'output-available' || call.name !== 'bash') {
      return false;
    }
    const run = extractSqlInvocation(inputCommand(call.input));
    if (run?.subcommand !== 'run') return false;
    return !alreadyValidated(ctx.lastAssistantMessages, run);
  };
}

/**
 * A context fragment nudging the model to `sql validate` before `sql run`.
 * Register it on the engine alongside schema fragments:
 *
 * ```ts
 * context.set(...schemaFragments, sqlValidateReminder());
 * ```
 *
 * Delivered as a tool-output `<system-reminder>` on the `sql run` result, and
 * suppressed when the model already validated that exact query.
 */
export function sqlValidateReminder() {
  return reminder(SQL_VALIDATE_REMINDER, {
    target: 'tool-output',
    when: sqlRunMissingValidate(),
  });
}
