import {
  createCodexFetch,
  resolveConfig,
} from '@opencoredev/loginwithchatgpt-core';

import { requestSignal } from '../request-signal.ts';
import { getLocalCodexAuth } from './local-credentials.ts';
import { codexProvider } from './provider.ts';

/** Creates AI SDK models; Zukhruf or the calling application owns the tool loop. */
export function createCodex() {
  return codexProvider((input, init) =>
    createCodexFetch({
      config: resolveConfig(),
      getAuth: () => getLocalCodexAuth(requestSignal(input, init)),
    })(input, init),
  );
}

export const codex = createCodex();

export {
  type CodexAccounts,
  type CodexAccountsOptions,
  type CodexConnectionState,
  createCodexAccounts,
} from './accounts.ts';
export { CodexAuthError, type CodexAuthErrorCode } from './errors.ts';
