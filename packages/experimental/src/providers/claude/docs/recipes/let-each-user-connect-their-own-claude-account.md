# Recipe: Let each user connect their own Claude account

**Use case.** Let each user connect their own Claude Pro or Max account. Keep each user's tokens separate and select their account for every model call.

**What you need.** [Application-owned accounts](../../README.md#application-owned-accounts) and a `KeyValueStore` from `@opencoredev/loginwithchatgpt-core`, keyed by your application's user ID. This program uses `MemoryStore`; use an encrypted, persistent store to retain tokens across restarts.

## The steps

1. Create one account manager per store with `createClaudeAccounts({ store, onChange })`.
2. When a user starts connecting, call `accounts.connect(owner)`, using your application's user ID as `owner`.
3. Show `authorizationUrl` to the user. The user signs in at claude.ai, and Claude shows a code.
4. Give the code to `accounts.complete(owner, code)`. If the state stays `pending`, show its `message` and ask for the code again.
5. Use `accounts.provider(owner)(modelId)` as the model for this user.
6. When the user disconnects, call `accounts.disconnect(owner)` to delete their tokens.

## The program

This CLI program prints the URL and reads the code from the terminal.

```ts title="connect-account.ts"
import { MemoryStore } from '@opencoredev/loginwithchatgpt-core';
import { generateText } from 'ai';
import { createInterface } from 'node:readline/promises';

import { createClaudeAccounts } from '@deepagents/experimental/providers/claude';

const accounts = createClaudeAccounts({
  store: new MemoryStore(), // A real app uses an encrypted store.
  onChange: (owner, state) => console.log(`[${owner}] ${state.status}`),
});
const owner = 'user-42'; // For example, the id of the signed-in user.

const signIn = await accounts.connect(owner);
if (signIn.status !== 'pending') {
  throw new Error(`Expected a sign-in, got ${signIn.status}`);
}
console.log(`Open this URL and sign in:\n${signIn.authorizationUrl}`);

const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});
let state = await accounts.complete(owner, await terminal.question('Code: '));
while (state.status === 'pending') {
  // The code did not match this sign-in, or Anthropic was busy. Try again.
  console.log(state.message);
  state = await accounts.complete(owner, await terminal.question('Code: '));
}
terminal.close();
if (state.status !== 'connected') {
  throw new Error(state.status === 'error' ? state.message : state.status);
}
console.log(`Connected as ${state.user?.email}`);

const { text } = await generateText({
  model: accounts.provider(owner)('claude-haiku-5-5'),
  prompt: 'Name the smallest planet in one word.',
});
console.log(text);

await accounts.disconnect(owner);
```

Output, until the program asks for the code. The URL is shortened: `…` replaces the end of the long query values.

```
[user-42] pending
Open this URL and sign in:
https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a…&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile+user%3Ainference&code_challenge=_Qyr4JqK…&code_challenge_method=S256&state=b9ad1682…
Code:
```

## Why it works

`connect` starts a PKCE sign-in for the owner and keeps it in memory for ten minutes. `complete` exchanges the authorization code for tokens and saves them under the owner's key. Models created by `provider(owner)` read that owner's tokens on each request, refreshing and saving them when they are expired or within one minute of expiry. `onChange` reports state changes: `pending` during sign-in, `connected` after sign-in, and `unauthenticated` after `disconnect`.

## Things to know

- **Create one instance per store.** Refreshes are serialized within that instance. Two instances sharing a store can both try to use the same refresh token.
- **A sign-in expires after ten minutes.** Then `complete` returns `error`. Call `connect` again.
- **A code rejected by the token endpoint ends sign-in** with the state `error`, except for HTTP 429 and server errors, which keep it `pending`. Invalid input, a code from another sign-in, and network failures also keep it `pending` so the user can retry.
- **`connect` does not replace a connection.** For an owner that is `connected` or `pending`, it returns that state. To connect another account, call `disconnect` first.
- **`listModels(owner)`** returns the model IDs available to that owner's account.
- **Failures of a connected account throw `ClaudeAuthError`.** See [Handle a rejected token or a usage limit](./handle-a-rejected-token-or-a-usage-limit.md).
