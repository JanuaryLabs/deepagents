# `LanguageModelV4StreamPart` quick reference

Type every in-code fixture with `satisfies LanguageModelV4StreamPart[]`. This validates fields and variants at compile time, but TypeScript cannot validate runtime ordering or matching IDs. For JSON fixtures or an empty result caused by bad lifecycle ordering, use the bundled semantic validator.

## Lifecycle parts

```ts
{ type: 'stream-start', warnings: [] }
{ type: 'response-metadata', id: 'response-1', modelId: 'mock-model' }

{ type: 'text-start', id: 'text-1' }
{ type: 'text-delta', id: 'text-1', delta: 'hello' }
{ type: 'text-end', id: 'text-1' }

{ type: 'reasoning-start', id: 'reasoning-1' }
{ type: 'reasoning-delta', id: 'reasoning-1', delta: 'thinking' }
{ type: 'reasoning-end', id: 'reasoning-1' }
```

Keep each start/delta/end group on the same `id`. The delta property is `delta`, never `textDelta`.

## Tool input and call

```ts
{ type: 'tool-input-start', id: 'call-1', toolName: 'search' }
{ type: 'tool-input-delta', id: 'call-1', delta: '{"query":' }
{ type: 'tool-input-delta', id: 'call-1', delta: '"weather"}' }
{ type: 'tool-input-end', id: 'call-1' }
{
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'search',
  input: '{"query":"weather"}',
}
```

V4 also supports `tool-approval-request` and `tool-result` parts. Copy their exact shape from the installed `LanguageModelV4ToolApprovalRequest` and `LanguageModelV4ToolResult` types when testing those flows.

## Other content

V4 stream unions include source, file, reasoning-file, custom-content, raw, and error parts. Their fields are richer than a one-line memory aid; inspect the corresponding installed `LanguageModelV4*` type and use `satisfies` for the specific test.

```ts
{ type: 'error', error: new Error('provider stream failed') }
{ type: 'raw', rawValue: { providerEvent: 'example' } }
```

## Terminal finish

```ts
{
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
  },
}
```

Unified reasons are `stop`, `length`, `content-filter`, `tool-calls`, `error`, and `other`. Return `{ stream }` from `doStream`; `rawCall` is not a V4 result field.

## Complete typed stream

```ts
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';

const chunks = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Hello' },
  { type: 'text-end', id: 'text-1' },
  {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
  },
] satisfies LanguageModelV4StreamPart[];
```
