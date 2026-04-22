# `LanguageModelV3StreamPart` catalog

Every variant of the V3 stream chunk type, with the exact fields required and why each exists. Source of truth: `LanguageModelV3StreamPart` in `@ai-sdk/provider/dist/index.d.ts`.

## Ordering rules that always apply

- `*-start` → zero or more `*-delta` → `*-end`, all sharing the same `id`.
- Different content streams (e.g. two parallel text generations, or a text stream alongside reasoning) each get their own `id` and interleave freely.
- `finish` must be the last chunk. Nothing after it is emitted.
- `stream-start` (if present) is first and carries the `warnings` array — the doStream equivalent of non-streaming's `warnings: []` field.

## Text

```ts
{ type: 'text-start', id: 't1' }
{ type: 'text-delta', id: 't1', delta: 'Hello ' }
{ type: 'text-delta', id: 't1', delta: 'world' }
{ type: 'text-end', id: 't1' }
```

Why `delta` not `textDelta`: `textDelta` belongs to the V2 spec. V3 renamed it to `delta` as part of unifying text, reasoning, and tool-input streaming under the same chunk shape. The V2 name is silently ignored.

## Reasoning (thinking / scratchpad)

Same shape as text, just `reasoning-*`:

```ts
{ type: 'reasoning-start', id: 'r1' }
{ type: 'reasoning-delta', id: 'r1', delta: 'Let me think...' }
{ type: 'reasoning-end', id: 'r1' }
```

These surface in `result.reasoning` for models that expose a thinking channel (Anthropic extended thinking, OpenAI o1, DeepSeek R1). In `totalUsage.outputTokens.reasoning` you'd see the reasoning token count.

## Tool-input streaming (progressive tool args)

When a model streams its tool arguments token-by-token (Anthropic's input streaming), the SDK emits input deltas before the final `tool-call`:

```ts
{ type: 'tool-input-start', id: 'call_1', toolName: 'search' }
{ type: 'tool-input-delta', id: 'call_1', delta: '{"query":' }
{ type: 'tool-input-delta', id: 'call_1', delta: '"weather"}' }
{ type: 'tool-input-end', id: 'call_1' }
{
  type: 'tool-call',
  toolCallId: 'call_1',
  toolName: 'search',
  input: '{"query":"weather"}',
}
```

Note: the `id` on the `tool-input-*` chunks matches the `toolCallId` on the final `tool-call` — same identifier, different field name. If your code under test surfaces partial tool args (e.g. to show "calling search…" in UI), you must emit these chunks; otherwise, a single `tool-call` chunk is sufficient.

## Tool call (final, with parsed args)

Used either as the only tool-related chunk or as the closer after `tool-input-*`:

```ts
{
  type: 'tool-call',
  toolCallId: 'call_1',
  toolName: 'search',
  input: '{"query":"weather"}',    // always stringified JSON
  providerExecuted: false,          // optional; true = provider runs the tool itself
  dynamic: false,                   // optional; true = tool is not in the static tool registry
}
```

## Tool result (provider-executed tools only)

Emitted for tools the provider runs on its side (e.g. Anthropic's computer-use, OpenAI's file search). You won't emit these for normal client-side tools — the SDK dispatches those via your `execute`.

```ts
{
  type: 'tool-result',
  toolCallId: 'call_1',
  toolName: 'search',
  result: { items: [/* ... */] },   // JSON-serializable
  isError: false,                   // optional
  preliminary: false,               // optional; true = will be replaced by a later non-preliminary result
}
```

## Source (retrieved content attribution)

```ts
{ type: 'source', sourceType: 'url', id: 's1', url: 'https://example.com', title: 'Example' }
```

or for document sources:

```ts
{
  type: 'source',
  sourceType: 'document',
  id: 's1',
  mediaType: 'application/pdf',
  title: 'Q4 Report',
  filename: 'q4.pdf',
}
```

## File (model-generated files, e.g. images)

```ts
{
  type: 'file',
  mediaType: 'image/png',
  data: 'base64-encoded-bytes',    // or a Uint8Array
}
```

## Stream metadata chunks

`stream-start` — emitted once at the beginning if the provider has warnings to surface:

```ts
{ type: 'stream-start', warnings: [] }
```

`response-metadata` — provider response IDs / model IDs / timestamps, typically near the start:

```ts
{
  type: 'response-metadata',
  id: 'resp_abc',
  timestamp: new Date('2024-01-01T00:00:00Z'),
  modelId: 'gpt-4o-2024-08-06',
}
```

## Finish (required, last)

```ts
{
  type: 'finish',
  finishReason: { unified: 'stop', raw: undefined },
  usage: testUsage,
  providerMetadata: undefined,       // optional
}
```

Unified finish reasons: `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'`. Use `'tool-calls'` when the stream ends because the model wants to call tools; `'stop'` for normal completion; `'length'` when `maxTokens` was hit.

## Error (soft error within a stream)

```ts
{ type: 'error', error: new Error('provider-side hiccup') }
```

Use this to test that your code surfaces provider-side errors without aborting the overall call. Distinct from throwing inside `doStream`, which propagates as an exception from `streamText`.

## Raw (passthrough of provider-specific data)

```ts
{ type: 'raw', rawValue: { anthropic_message_id: 'msg_123' } }
```

Only relevant if the code under test reads `rawValue` — otherwise skip.

## A complete realistic stream

Text answer that calls a tool mid-way:

```ts
const stream = simulateReadableStream({
  chunks: [
    { type: 'stream-start', warnings: [] },
    {
      type: 'response-metadata',
      id: 'r1',
      modelId: 'mock-model-id',
      timestamp: new Date(),
    },

    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'Let me look that up. ' },
    { type: 'text-end', id: 't1' },

    { type: 'tool-input-start', id: 'call_1', toolName: 'search' },
    { type: 'tool-input-delta', id: 'call_1', delta: '{"q":"weather"}' },
    { type: 'tool-input-end', id: 'call_1' },
    {
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'search',
      input: '{"q":"weather"}',
    },

    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: testUsage,
    },
  ],
});
```
