import type { SandboxExtension } from '@deepagents/context';

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
 * @param adapter Database adapter.
 * @param options `outputDir` overrides where `sql run` writes result files
 *   (default `/sql`). Useful on backends where `/` is not writable.
 */
export function sqlSandboxExtension(
  adapter: Adapter,
  options: SqlSandboxExtensionOptions = {},
): SandboxExtension {
  const { command, repair } = createSqlCommand(adapter, options);
  return {
    commands: [command],
    plugins: [new SqlBacktickRewritePlugin(), new SqlProxyEnforcementPlugin()],
    onBeforeBashCall: ({ command: c }) => ({ command: repair(c) }),
  };
}
