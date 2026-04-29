import type { SandboxExtension } from '@deepagents/context';

import { validateAdapterNames } from './adapter-name.ts';
import type { Adapter } from './adapters/adapter.ts';
import {
  type SqlCommandOptions,
  createSqlCommand,
} from './agents/sql-command.ts';
import {
  SqlBacktickRewritePlugin,
  SqlProxyEnforcementPlugin,
} from './agents/sql-transform-plugins.ts';

export interface SqlSandboxExtensionOptions extends SqlCommandOptions {}

/**
 * Returns the SQL subcommand, transform plugins, and argument-repair hook as
 * a composable {@link SandboxExtension}. Pass it via `hostExtensions` to
 * `createRoutingSandbox`, layered over whichever backend you're using
 * (`createVirtualSandbox`, `createDockerSandbox`, etc.).
 *
 * The LLM routes queries to a specific database via a positional name:
 * `sql run <db> "SELECT ..."` / `sql validate <db> "SELECT ..."`.
 *
 * @param adapters Named map of database adapters. Keys must match
 *   `/^[A-Za-z_][A-Za-z0-9_]*$/` and are used as the `<db>` argument.
 * @param options `outputDir` overrides where `sql run` writes result files
 *   (default `/sql`). Useful on backends where `/` is not writable.
 */
export function sqlSandboxExtension(
  adapters: Record<string, Adapter>,
  options: SqlSandboxExtensionOptions = {},
): SandboxExtension {
  validateAdapterNames(Object.keys(adapters));
  const { command, repair } = createSqlCommand(adapters, options);
  return {
    commands: [command],
    plugins: [new SqlBacktickRewritePlugin(), new SqlProxyEnforcementPlugin()],
    onBeforeBashCall: ({ command: c }) => ({ command: repair(c) }),
  };
}
