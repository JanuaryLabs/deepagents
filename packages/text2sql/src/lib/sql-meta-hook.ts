import type { CommandResult } from '@deepagents/context';

import {
  type SqlQueryInvocation,
  parseSqlQueryInvocation,
} from './sql-invocation.ts';

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

      const adapter = adapters[invocation.dbName];
      if (!adapter) return undefined;

      try {
        return {
          meta: { formattedSql: adapter.format(invocation.sql) },
        };
      } catch {
        // Formatting metadata is best-effort and must not change command output.
        return undefined;
      }
    },
  };
}
