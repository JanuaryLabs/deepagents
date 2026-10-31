import { requestSignal } from '../request-signal.ts';
import { getLocalClaudeAuth } from './local-credentials.ts';
import { claudeProvider, withBearer } from './provider.ts';

export interface ClaudeOptions {
  /**
   * The environment that holds `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
   * and `USER`, read on each request. Default: `process.env`, as for the `env`
   * option of `child_process.spawn`.
   */
  env?: NodeJS.ProcessEnv;
}

/** Creates AI SDK models using the existing Claude Code login. */
export function createClaude({ env }: ClaudeOptions = {}) {
  return claudeProvider(async (input, init) =>
    globalThis.fetch(
      input,
      withBearer(
        init,
        await getLocalClaudeAuth(
          env ?? process.env,
          requestSignal(input, init),
        ),
      ),
    ),
  );
}

export const claude = createClaude();

export {
  type ClaudeAccounts,
  type ClaudeAccountsOptions,
  type ClaudeConnectionState,
  type ClaudeTokens,
  type ClaudeUser,
  createClaudeAccounts,
} from './accounts.ts';
export { ClaudeAuthError, type ClaudeAuthErrorCode } from './errors.ts';
