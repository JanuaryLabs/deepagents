# Recipe: Call Claude with your Claude Code login

**Use case.** You use Claude Code on your computer. A script must call a Claude model with the same login. You do not want to make or keep an API key.

**What you need.** A [stored Claude Code login](../../README.md#stored-claude-code-login) for the OS user that runs the script. The packages `@deepagents/experimental` and `ai`.

## The steps

1. Run `claude auth login` one time.
2. Import the provider `claude` from `@deepagents/experimental/providers/claude`.
3. Give `claude('claude-haiku-5-5')` to `generateText` of the AI SDK as the model.

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

The provider reads the login on each request. It sends the token of the login to Anthropic's Messages endpoint. If the token expires in less than one minute, the provider refreshes it and saves the new token in the same store. See [Existing login](../../README.md#existing-login).

## Things to know

- **An environment token comes first.** If `CLAUDE_CODE_OAUTH_TOKEN` has a value, the provider uses it and does not read the stored login. See [Environment token](../../README.md#environment-token).
- **The script uses the limits of your Claude account.** Its calls count with your Claude Code work. When the account is at a usage limit, the call fails with a 429. See [Handle a rejected token or a usage limit](./handle-a-rejected-token-or-a-usage-limit.md).
- **The import does not read the login.** The first request reads it. With no stored login, the request fails with ``No usable local Claude login. Run `claude auth login` on this machine.``
- **Use other models in the same way**, for example `claude('claude-sonnet-5-5')`.
