# Recipe: Run on a server with a long-lived token

**Use case.** Call Claude with your subscription from a server, container, or CI job that has no stored Claude Code login.

**What you need.** A long-lived token from `claude setup-token`, in your secret store. Read [Environment token](../../README.md#environment-token).

## The steps

1. Run `claude setup-token` on your computer and copy the token.
2. Put the token in your secret store, for example as a Docker or Kubernetes secret.
3. In the program, read the token from the secret store.
4. Pass the token to `createClaude({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } })` to configure this provider without changing `process.env`.

## The program

The program reads the token from a secret file. Pass its path as the first argument, for example `node server-token.ts /run/secrets/claude-oauth-token`. This example assumes a secret named `claude-oauth-token` is mounted at that path.

```ts title="server-token.ts"
import { generateText } from 'ai';
import { readFile } from 'node:fs/promises';

import { createClaude } from '@deepagents/experimental/providers/claude';

// The secret store gives the token as a file, for example a Docker or Kubernetes secret.
const [tokenFile] = process.argv.slice(2);
if (tokenFile === undefined)
  throw new Error('Give the path of the token file.');
const token = (await readFile(tokenFile, 'utf8')).trim();

// Only this provider sees the token. process.env stays as it is.
const claude = createClaude({ env: { CLAUDE_CODE_OAUTH_TOKEN: token } });

const { text } = await generateText({
  model: claude('claude-haiku-5-5'),
  prompt: 'Name the largest planet in one word.',
});

console.log(text);
console.log(
  'CLAUDE_CODE_OAUTH_TOKEN in process.env:',
  'CLAUDE_CODE_OAUTH_TOKEN' in process.env,
);
```

Output:

```
Jupiter
CLAUDE_CODE_OAUTH_TOKEN in process.env: false
```

## Why it works

The `env` option replaces `process.env` for the provider's reads of `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, and `USER`. A nonempty token takes precedence over the stored login. The provider sends it on each request without refreshing it. Passing `env` here does not add the token to the process environment or to child processes' inherited environments.

## Things to know

- **A 401 fails the request.** The provider does not try the stored login after Anthropic rejects the token. Make a new token with `claude setup-token`, and put it in the secret store. See [Handle a rejected token or a usage limit](./handle-a-rejected-token-or-a-usage-limit.md).
- **An empty token falls back to the stored login.** On a server with no stored login, the request fails.
- **The provider reads `env` on each request.** If you change `CLAUDE_CODE_OAUTH_TOKEN` in the same object, the next request uses the new token. You do not need a new provider.
- **Without the `env` option**, the provider reads `process.env`. If the server process starts with `CLAUDE_CODE_OAUTH_TOKEN` in its environment, `claude` uses that token, and you do not need `createClaude`.
