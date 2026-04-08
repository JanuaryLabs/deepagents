---
name: agent-testing
description: 'Write tests for AI agent code using MockLanguageModelV3 from ai/test. Use when the user asks to write tests for agents, test AI/LLM functions, mock model responses, test retry logic, test structured output, test streaming, test tool calls, or add test coverage for any code that uses the Vercel AI SDK.'
---

# AI Agent Testing with Vercel AI SDK

## Setup

- **Runner**: Node.js built-in (`node:test`). Run: `node --test path/to/test.ts`
- **Assertions**: `import assert from 'node:assert'`
- **Mocks**: `import { MockLanguageModelV3 } from 'ai/test'`
- **Stream simulation**: `import { simulateReadableStream } from 'ai'`
- **Build before test**: If tests import from package specifiers (e.g., `@scope/pkg`), build the package first
- **Import rule**: Use package specifiers in test files, not relative source paths — avoids type mismatches with private class members

## Reference Files

- **[mock-patterns.md](references/mock-patterns.md)**: All MockLanguageModelV3 patterns with complete examples — `doGenerate` (static, async, capturing, throwing), `doStream`, tool calls. Read this before writing any test.

## Key Conventions

1. Each test creates its own data — no shared mutable state
2. Bypass `smoothStream()` in streaming tests: `transform: () => new TransformStream()`
3. V3 streaming uses `delta` not `textDelta`, requires `id` on text chunks
4. `doGenerate` does NOT auto-simulate `doStream` — provide both if your code calls `streamText()`

## Retryable AI SDK Errors

Import from `'ai'` when testing retry logic:

```ts
import {
  APICallError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  TypeValidationError,
} from 'ai';
```
