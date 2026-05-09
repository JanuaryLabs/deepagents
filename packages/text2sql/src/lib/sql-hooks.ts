import {
  type CreateSqlMetaHookOptions,
  createSqlMetaHook,
} from './sql-meta-hook.ts';
import { repairSqlCommand } from './sql-repair.ts';
import { transformSqlCommand } from './sql-transform.ts';

export { createSqlMetaHook } from './sql-meta-hook.ts';
export type {
  CreateSqlMetaHookOptions,
  SqlCommandFormatter,
} from './sql-meta-hook.ts';
export { repairSqlCommand } from './sql-repair.ts';
export { transformSqlCommand } from './sql-transform.ts';

export type CreateSqlCommandHooksOptions = CreateSqlMetaHookOptions;

export function createSqlCommandHooks({
  adapters,
}: CreateSqlCommandHooksOptions) {
  const meta = createSqlMetaHook({ adapters });

  return {
    onBeforeBashCall: ({ command }: { command: string }) => {
      const repaired = repairSqlCommand(command);
      const transformed = transformSqlCommand(repaired);
      meta.track({ repaired, transformed });
      return { command: transformed };
    },
    onAfterBashCall: meta.onAfterBashCall,
  };
}
