# Claude model provider

```ts
import { claude } from '@deepagents/experimental/providers/claude';

const model = claude('claude-sonnet-4-6');
```

Use the model in Zukhruf's `defineAgent({ ...declaration, model })`, or with
AI SDK's `generateText` and `streamText`. `createClaude()` creates another
provider with the same configuration. Both are callable `ProviderV4` instances:
`claude.languageModel(modelId)` and `createProviderRegistry({ claude })` work too.
Importing the provider does not read credentials or make network requests.

Zukhruf owns tools, history, reminders, mailbox, and scheduling. The provider
uses `@ai-sdk/anthropic` to encode requests and parse JSON and streaming responses;
it does not start Claude Code or the Claude Agent SDK.

## Existing login

Run `claude auth login` as the same OS user as the application. Credentials are
resolved on each request from `CLAUDE_CONFIG_DIR`, or `~/.claude` when unset:

- macOS: read the native `Claude Code-credentials` keychain entry. An explicit
  config directory selects its native hash-suffixed entry. Only an absent entry
  falls back to `.credentials.json`; malformed or inaccessible entries fail.
- Linux and Windows: read `.credentials.json` in that config directory.

The login must contain Claude inference scopes. API-key environment variables and
`ANTHROPIC_BASE_URL` do not redirect this provider; requests go to Anthropic's
Messages endpoint using the native login. Application-owned credentials are not
implemented yet.

Tokens within one minute of expiry are refreshed and persisted to the same store,
preserving other fields. File writes are atomic with mode `0600`. Concurrent
provider processes coordinate refresh through a lock and recheck the saved login
before writing. The native CLI does not share that lock, so a simultaneous
CLI/provider rotation can still race (backlog #1812). Cancellation reaches both
refresh and model requests.

## Model behavior

Anthropic model options retain their standard `providerOptions.anthropic`
namespace. AI SDK's `defaultSettingsMiddleware` enables automatic ephemeral
prompt caching; explicit caller settings such as a one-hour TTL take precedence.
Native tool names and inputs pass through unchanged. Unsupported modalities fail
locally with AI SDK's `NoSuchModelError`.

For manually managed AI SDK history, append `result.responseMessages` to retain
all tool steps. Zukhruf persists that history itself.

Native subscription access uses a private compatibility protocol: the OAuth beta
header and a prepended Claude Agent SDK identity instruction. These are isolated
in `index.ts`; the application instructions follow them. This is experimental,
not an official third-party subscription API, and server acceptance can change.
No tool-name, SSE, billing-body, or user-agent rewriting is needed by the
live-verified flow.

Verified on September 17, 2026 with `claude-sonnet-4-6` in an isolated copy of the
Zukhruf schedules demo, substituting only the model provider. A scheduled run
executed bash to calculate `23 * 19`, returned `437`, and recalled that result on
the next conversation turn using persisted history.

The implementation follows the shared [provider protocol](../codex/README.md#adding-another-provider).
