# Recipe: Handle a rejected token or a usage limit

**Use case.** A model call fails. The program must tell the user what to do. A rejected token needs a new login. A usage limit of the account needs a wait, sometimes of days. For another 429, the program shows the headers that Anthropic sent.

**What you need.** `APICallError` of the AI SDK, for the provider `claude` with an [environment token](../../README.md#environment-token) or a [stored login](../../README.md#stored-claude-code-login). `ClaudeAuthError` of the provider, for [application-owned accounts](../../README.md#application-owned-accounts).

## The steps

1. Call `generateText` with `maxRetries: 0`. Then the program decides when to try again.
2. Catch the error. If it is a `ClaudeAuthError`, read its `code`.
3. If it is an `APICallError` with `statusCode` 401, Anthropic rejected the token.
4. If `statusCode` is 429, read the response headers. If `anthropic-ratelimit-unified-status` is `rejected`, the account is at a usage limit. `anthropic-ratelimit-unified-representative-claim` names the limit, and `anthropic-ratelimit-unified-reset` gives its end in seconds since 1970.
5. Throw all other errors again.

## The program

The program asks two models: `claude`, and the model of an owner with no connected account.

```ts title="handle-failures.ts"
import { MemoryStore } from '@opencoredev/loginwithchatgpt-core';
import { APICallError, type LanguageModel, generateText } from 'ai';

import {
  ClaudeAuthError,
  claude,
  createClaudeAccounts,
} from '@deepagents/experimental/providers/claude';

async function ask(model: LanguageModel) {
  try {
    const { text } = await generateText({
      model,
      prompt: 'Say hello in one word.',
      maxRetries: 0, // This program decides when to try again.
    });
    return { ok: text };
  } catch (error) {
    return describe(error);
  }
}

function describe(error: unknown) {
  if (error instanceof ClaudeAuthError) {
    return { failed: 'application-owned account', code: error.code };
  }
  if (!APICallError.isInstance(error)) throw error;
  if (error.statusCode === 401) {
    return { failed: 'token rejected' };
  }
  if (error.statusCode !== 429) throw error;

  const header = (name: string) =>
    error.responseHeaders?.[`anthropic-ratelimit-unified-${name}`];
  if (header('status') !== 'rejected') {
    // Not a usage limit of the account: show what Anthropic sent.
    return {
      failed: 'rate limited',
      status: header('status'),
      retryAfter: error.responseHeaders?.['retry-after'],
    };
  }
  return {
    failed: 'usage limit',
    window: header('representative-claim'), // five_hour or seven_day
    sevenDayUtilization: Number(header('7d-utilization')),
    resetsAt: new Date(Number(header('reset')) * 1000).toISOString(),
    extraUsage: header('overage-disabled-reason'),
  };
}

console.log('login:', await ask(claude('claude-haiku-5-5')));

const accounts = createClaudeAccounts({ store: new MemoryStore() });
const model = accounts.provider('user-42')('claude-haiku-5-5');
console.log('account:', await ask(model));
```

Output with `CLAUDE_CODE_OAUTH_TOKEN=not-a-real-token`:

```
login: { failed: 'token rejected' }
account: { failed: 'application-owned account', code: 'not-connected' }
```

Output with a stored login at its 7-day limit:

```
login: {
  failed: 'usage limit',
  window: 'seven_day',
  sevenDayUtilization: 1,
  resetsAt: '2026-11-01T19:00:00.000Z',
  extraUsage: 'org_level_disabled'
}
account: { failed: 'application-owned account', code: 'not-connected' }
```

## Why it works

The AI SDK changes each error response of Anthropic into an `APICallError`. The error keeps the status code and the response headers. For a subscription login, Anthropic sends the `anthropic-ratelimit-unified-*` headers. They give the status, the utilization and the reset of each limit of the account: `5h` for five hours and `7d` for seven days. The models of an application-owned account throw `ClaudeAuthError` when they cannot get a token. Here the owner has no tokens, so the provider throws `not-connected` and sends no request.

## Things to know

- **The codes of `ClaudeAuthError`:**
  - `not-connected`: the owner has no tokens. Call `connect`.
  - `refresh-token-invalid`: the connection expired, or the user revoked it. The provider deleted the tokens. Call `connect`.
  - `access-token-invalid`: Anthropic rejected the token after one refresh. Call `connect`.
  - `refresh-failed`: the refresh did not complete. Try the request again.
  - `invalid-token-response`: Anthropic sent a refresh response that the provider cannot read. Try again later.
  - `models-request-failed`: `listModels` failed.
- **The default retries waste calls at a usage limit.** Without `maxRetries: 0`, the AI SDK sends a 429 request two more times. Then it throws a `RetryError`, with the last `APICallError` in `lastError`.
- **A 401 needs a new login.** For an environment token, run `claude setup-token`. For a stored login, run `claude auth login`. The provider does not use the stored login after it rejects an environment token.
- **`anthropic-ratelimit-unified-overage-disabled-reason`** tells why the account cannot use extra usage after the limit.
- **These headers are part of a private protocol.** Anthropic can change them. See [Model behavior](../../README.md#model-behavior).
