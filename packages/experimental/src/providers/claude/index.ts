import { requestSignal } from '../request-signal.ts';
import { getLocalClaudeAuth } from './local-credentials.ts';
import { claudeProvider, withBearer } from './provider.ts';

/** Creates AI SDK models using the existing Claude Code login. */
export function createClaude() {
  return claudeProvider(async (input, init) =>
    globalThis.fetch(
      input,
      withBearer(init, await getLocalClaudeAuth(requestSignal(input, init))),
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
