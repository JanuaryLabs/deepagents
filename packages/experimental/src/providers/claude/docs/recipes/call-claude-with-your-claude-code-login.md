# Recipe: Call Claude with your Claude Code login

**Use case.** Call a Claude model from a script using your existing Claude Code login, without creating or storing an API key.

**What you need.** A [stored Claude Code login](../../README.md#stored-claude-code-login) for the OS user running the script, plus the `@deepagents/experimental` and `ai` packages.

## The steps

1. Run `claude auth login` once.
2. Import the `claude` provider from `@deepagents/experimental/providers/claude`.
3. Pass `claude('claude-haiku-5-5')` as the model to the AI SDK's `generateText`.

## The program

```ts title="first-call.ts"
import { generateText } from 'ai';

import { claude } from '@deepagents/experimental/providers/claude';

const { text } = await generateText({
  model: claude('claude-haiku-5-5'),
  prompt: 'Name the capital of France in one word.',
});

console.log(text);
```

Run it with `node first-call.ts`.

Output:

```
Paris
```

## Why it works

The provider reads the stored login on each request and sends its access token to Anthropic's Messages endpoint. It refreshes tokens that are expired or within one minute of expiry and saves them in the same store. See [Existing login](../../README.md#existing-login).

## Things to know

- **An environment token comes first.** If `CLAUDE_CODE_OAUTH_TOKEN` has a value, the provider uses it and does not read the stored login. See [Environment token](../../README.md#environment-token).
- **The script shares your Claude account's usage limits.** Its calls count toward the same limits as Claude Code. When the account reaches a usage limit, the call fails with HTTP 429. See [Handle a rejected token or a usage limit](./handle-a-rejected-token-or-a-usage-limit.md).
- **The import does not read the login.** The first request reads it. With no stored login, the request fails with ``No usable local Claude login. Run `claude auth login` on this machine.``
- **Use other models in the same way**, for example `claude('claude-sonnet-5-5')`.
