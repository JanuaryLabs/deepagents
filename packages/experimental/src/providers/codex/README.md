# Codex model provider

```ts
import { codex } from '@deepagents/experimental/providers/codex';

const model = codex('gpt-5.5');
```

Use `model` in a Zukhruf `defineAgent({ ...declaration, model })`, or with AI SDK
`streamText` and `generateText`. Both `codex` and the exported `createCodex()`
factory expose a callable AI SDK `ProviderV4`, returning `LanguageModelV4` models.
Importing the singleton does not read
credentials or make network requests.
Available model IDs depend on the signed-in account; `gpt-5.5` was verified during
implementation. The provider forwards model selection without maintaining a catalog.

The standard provider API works too:

```ts
import { createProviderRegistry } from 'ai';

import { codex } from '@deepagents/experimental/providers/codex';

const model = codex.languageModel('gpt-5.5');
const registry = createProviderRegistry({ codex });
const registeredModel = registry.languageModel('codex:gpt-5.5');
```

Both entry points apply the same middleware. Unsupported modalities, including
embeddings and image generation, throw AI SDK's `NoSuchModelError` locally.

Zukhruf keeps ownership of tools, conversation history, reminders, mailbox, and
scheduling. This provider calls the ChatGPT-backed Codex model endpoint; it does
not start a Codex agent or create a native Codex conversation.

## Existing login

Run `codex login` with ChatGPT on the same machine and OS user as the Node.js
application. Credentials are resolved lazily on each model request from
`CODEX_HOME`, or `~/.codex` when unset. The provider follows the top-level
`cli_auth_credentials_store` setting in that home's `config.toml`:

- `file` (default): read and refresh `auth.json`.
- `keyring`: use Codex's `Codex Auth` entry in the OS credential store.
- `auto`: use that keyring entry when present, otherwise `auth.json`.
- `ephemeral`: fail with instructions to use a persistent login.

An unreadable or locked keyring fails instead of silently selecting another
account. Native keyring bindings load only for `keyring` and `auto`. Missing,
malformed, or API-key credentials produce an actionable login error;
`OPENAI_API_KEY` is not used by this provider.

Expired access tokens are refreshed and saved back to the selected native store,
preserving additional credential fields. File writes are atomic with mode `0600`.
Provider processes coordinate refresh through a lock in the Codex home and reread
credentials before saving, so a completed login change is detected. Codex CLI
does not share this lock: simultaneous CLI/provider refresh can still race
(backlog #1812). Cancellation reaches both refresh and model requests.

## Model behavior

Requests use stateless Responses streaming. The provider forces `store: false`
before encoding history, preserving prior tool calls and encrypted reasoning.
`generateText` aggregates that same stream. Standard tools execute in the calling
application. OpenAI model settings use `providerOptions.openai`, for example
`{ reasoningEffort: 'low' }`. The Codex transport removes unsupported output-token
limits; do not rely on `maxOutputTokens` to cap a response.

When managing history directly with AI SDK, append `result.responseMessages`
to retain every tool step. Zukhruf persists and restores its own history.

Only local ChatGPT login is implemented here. Application-owned credentials are
not implemented yet. The [Claude provider](../claude/README.md) follows the same
AI SDK protocol with its own native login transport.

## Adding another provider

The pattern is adapter composition with AI SDK middleware. The protocol is
AI SDK's `ProviderV4` / `LanguageModelV4`; there is no separate harness protocol.

1. Configure the vendor's native AI SDK provider with its own credential-aware
   fetch transport. Let that provider encode requests and parse responses.
2. Pass its language-model factory and any `LanguageModelMiddleware` to the
   private `createLanguageModelProvider` helper (use `[]` if none is needed).
   It composes AI SDK's `customProvider` and `wrapProvider`, then adds callable
   syntax. Export the factory and its default singleton from the new subpath.
3. Verify public calls through `generateText`, `streamText`, the provider registry,
   and Zukhruf's tool/history flow, alongside that provider's login behavior.

Claude uses `createAnthropic`; its credential store and refresh behavior live in
its adapter. Codex's forced `store: false` and
stream-to-generate conversion remain Codex-specific. AI SDK's
`defaultSettingsMiddleware` allows caller overrides, so it cannot enforce the
Codex storage requirement. `simulateStreamingMiddleware` converts generation to
streaming, the opposite of what Codex's stream-only endpoint needs.
