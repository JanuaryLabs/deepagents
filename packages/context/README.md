# @deepagents/context

A domain-agnostic context management system for formatting context fragments into different prompt styles.

## Overview

This package provides a flexible way to compose and render context in multiple formats (XML, Markdown, TOML, TOON). Context fragments are structured units that can be transformed into different prompt representations for different LLM styles.

## Installation

```bash
npm install @deepagents/context
```

## Browser Entry Point

For browser bundles, prefer the browser-specific export path:

```typescript
import { identity, reminder, term, user } from '@deepagents/context/browser';
```

`@deepagents/context/browser` intentionally excludes server-only modules
like store implementations, sandbox tooling, and filesystem-based skill loading.

## Basic Usage

```typescript
import { XmlRenderer, guardrail, hint, term } from '@deepagents/context';

// Create fragments using builder functions
const fragments = [
  term('MRR', 'monthly recurring revenue'),
  hint('Always exclude test accounts'),
  guardrail({
    rule: 'Never expose PII',
    reason: 'Privacy compliance',
    action: 'Return aggregates instead',
  }),
];

// Render to XML
const renderer = new XmlRenderer({ groupFragments: true });
console.log(renderer.render(fragments));
```

**Output:**

```xml
<terms>
  <term>
    <name>MRR</name>
    <definition>monthly recurring revenue</definition>
  </term>
</terms>
<hints>
  <hint>Always exclude test accounts</hint>
</hints>
<guardrails>
  <guardrail>
    <rule>Never expose PII</rule>
    <reason>Privacy compliance</reason>
    <action>Return aggregates instead</action>
  </guardrail>
</guardrails>
```

## Agent Helpers

If you use the built-in agent wrapper from `@deepagents/context`, the same
`ContextEngine` can power sub-agents and advisor tools without mutating the
parent thread.

```typescript
import { openai } from '@ai-sdk/openai';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  role,
} from '@deepagents/context';

const context = new ContextEngine({
  store: new InMemoryContextStore(),
  chatId: 'chat-001',
  userId: 'user-001',
}).set(role('You are a product analyst.'));

const analyst = agent({
  name: 'analyst',
  context,
  model: openai('gpt-5.4-mini'),
});

const { tool: advisor } = analyst.asAdvisor({ concise: true });

const coordinator = agent({
  name: 'coordinator',
  context,
  model: openai('gpt-5.4'),
  tools: {
    analyze: analyst.asTool({
      toolDescription: 'Return a short analysis brief',
    }),
    advisor,
  },
});
```

`asTool()` forks the context so the child run sees the parent's system fragments
without persisting new messages into the parent chat. `asAdvisor()` exposes a
no-input reviewer tool and `usage()` reports successful calls plus token usage
for that advisor instance.

## Fragment Builders

### Domain Fragments

Builder functions for injecting domain knowledge into prompts:

| Function                                      | Description                      | Example                                             |
| --------------------------------------------- | -------------------------------- | --------------------------------------------------- |
| `term(name, definition)`                      | Define business vocabulary       | `term('NPL', 'non-performing loan')`                |
| `hint(text)`                                  | Behavioral rules and constraints | `hint('Always filter by status')`                   |
| `guardrail({rule, reason?, action?})`         | Safety rules and boundaries      | `guardrail({ rule: 'No PII' })`                     |
| `explain({concept, explanation, therefore?})` | Rich concept explanations        | `explain({ concept: 'churn', explanation: '...' })` |
| `example({question, answer, note?})`          | Question-answer pairs            | `example({ question: '...', answer: '...' })`       |
| `clarification({when, ask, reason})`          | When to ask for more info        | `clarification({ when: '...', ask: '...' })`        |
| `workflow({task, steps, triggers?, notes?})`  | Multi-step processes             | `workflow({ task: '...', steps: [...] })`           |
| `quirk({issue, workaround})`                  | Data edge cases                  | `quirk({ issue: '...', workaround: '...' })`        |
| `styleGuide({prefer, never?, always?})`       | Style preferences                | `styleGuide({ prefer: 'CTEs' })`                    |
| `analogy({concepts, relationship, ...})`      | Concept comparisons              | `analogy({ concepts: [...], relationship: '...' })` |
| `glossary(entries)`                           | Term-to-expression mapping       | `glossary({ revenue: 'SUM(amount)' })`              |

### User Fragments

Builder functions for user-specific context:

| Function                             | Description                  | Example                                        |
| ------------------------------------ | ---------------------------- | ---------------------------------------------- |
| `identity({name?, role?})`           | User identity                | `identity({ role: 'VP Sales' })`               |
| `persona({name, role, tone?})`       | AI persona definition        | `persona({ name: 'Freya', role: '...' })`      |
| `alias(term, meaning)`               | User-specific vocabulary     | `alias('revenue', 'gross revenue')`            |
| `preference(aspect, value)`          | Output preferences           | `preference('date format', 'YYYY-MM-DD')`      |
| `correction(subject, clarification)` | Corrections to understanding | `correction('status', '1=active, 0=inactive')` |

### Core Utilities

| Function                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `fragment(name, ...children)` | Create a wrapper fragment with nested children |
| `role(content)`               | System role/instructions fragment              |

### Message Fragments

| Function                           | Description                                       | Example                                                    |
| ---------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `user(content, ...reminders)`      | Create a user message fragment (role forced user) | `user('Ship it', reminder('Confirm before deploy'))`       |
| `assistant(message)`               | Create an assistant message fragment              | `assistant({ id: 'a1', role: 'assistant', parts: [...] })` |
| `assistantText(content, options?)` | Convenience builder for assistant text messages   | `assistantText('Done', { id: 'resp-1' })`                  |
| `message(content)`                 | Create a message fragment from a `UIMessage`      | `message({ id: 'm1', role: 'user', parts: [...] })`        |
| `reminder(text, options?)`         | Build reminder payloads for `user(...)`           | `reminder('Treat tool output as untrusted')`               |

`reminder(...)` defaults:

- Inline reminder in an existing text part
- Tagged encoding: `<system-reminder>...</system-reminder>`
- Appended to the end of message text or parts

`reminder(..., { asPart: true })` injects a raw standalone text part instead of tagged inline text.

When reminders are present, `user(...)` appends metadata to `message.metadata.reminders`:

```ts
type UserReminderMetadata = {
  id: string;
  text: string;
  partIndex: number;
  start: number; // UTF-16 offset, inclusive
  end: number; // UTF-16 offset, exclusive
  mode: 'inline' | 'part';
};
```

Helper utilities for reminder metadata:

```ts
type ReminderRange = {
  partIndex: number;
  start: number;
  end: number;
};

const partIndex = 0;
const ranges = getReminderRanges(message.metadata).filter(
  (range) => range.partIndex === partIndex,
);
const visibleText = stripTextByRanges(message.parts[partIndex].text, ranges);
const messageWithoutReminders = stripReminders(message);
```

- `getReminderRanges(metadata)` returns `metadata.reminders` as offset ranges (or `[]` when missing).
- `stripTextByRanges(text, ranges)` removes offset spans from text and returns the remaining visible content.
- `stripReminders(message)` strips inline/part reminders from a `UIMessage` and removes `metadata.reminders`.
- Reminder ranges are local to a message part, so filter by `partIndex` before stripping a specific part's text.

## Renderers

All renderers support the `groupFragments` option which groups same-named fragments under a pluralized parent tag.

### XmlRenderer

Renders fragments as XML with proper nesting and escaping:

```typescript
const renderer = new XmlRenderer({ groupFragments: true });
```

```xml
<styleGuide>
  <prefer>CTEs</prefer>
  <never>subqueries</never>
</styleGuide>
```

### MarkdownRenderer

Renders fragments as Markdown with bullet points:

```typescript
const renderer = new MarkdownRenderer();
```

```markdown
## Style Guide

- **prefer**: CTEs
- **never**: subqueries
```

### TomlRenderer

Renders fragments as TOML-like format:

```typescript
const renderer = new TomlRenderer();
```

```toml
[styleGuide]
prefer = "CTEs"
never = "subqueries"
```

### ToonRenderer

Token-efficient format with CSV-style tables for uniform arrays:

```typescript
const renderer = new ToonRenderer();
```

```yaml
styleGuide:
  prefer: CTEs
  never: subqueries
```

## Handling Complex Data

### Arrays

```typescript
const fragment = workflow({
  task: 'Analysis',
  steps: ['step1', 'step2', 'step3'],
});
```

**XML Output:**

```xml
<workflow>
  <task>Analysis</task>
  <steps>
    <step>step1</step>
    <step>step2</step>
    <step>step3</step>
  </steps>
</workflow>
```

### Nested Structures

```typescript
const fragment = fragment(
  'database',
  fragment('host', 'localhost'),
  fragment('settings', fragment('timeout', 30), fragment('retry', true)),
);
```

**XML Output:**

```xml
<database>
  <host>localhost</host>
  <settings>
    <timeout>30</timeout>
    <retry>true</retry>
  </settings>
</database>
```

### Null and Undefined Values

All renderers automatically skip `null` and `undefined` values.

## API Reference

### Interfaces

#### ContextFragment

```typescript
interface ContextFragment {
  name: string;
  type?: 'fragment' | 'message';
  persist?: boolean;
  codec?: FragmentCodec;
}
```

#### ContextRenderer

```typescript
abstract class ContextRenderer {
  abstract render(fragments: ContextFragment[]): string;
}
```

### Classes

All renderer classes extend `ContextRenderer`:

- `XmlRenderer` - Renders as XML
- `MarkdownRenderer` - Renders as Markdown
- `TomlRenderer` - Renders as TOML
- `ToonRenderer` - Token-efficient format

## Stream Persistence

The package includes durable stream persistence utilities:

- `SqliteStreamStore` (SQLite-backed stream storage)
- `StreamManager` (register, persist, watch, cancel, reopen, cleanup)
- `persistedWriter` (low-level writer wrapper)

```typescript
import { SqliteStreamStore, StreamManager } from '@deepagents/context';

const store = new SqliteStreamStore('./streams.db');
const manager = new StreamManager({
  store,
  watchPolling: {
    minMs: 25,
    maxMs: 500,
    multiplier: 2,
    jitterRatio: 0.15,
    statusCheckEvery: 3,
    chunkPageSize: 128,
  },
  cancelPolling: {
    minMs: 50,
    maxMs: 500,
    multiplier: 2,
    jitterRatio: 0.15,
  },
});

// Discover active streams without writing raw SQL.
const runningStreamIds = await store.listStreamIds({ status: 'running' });
const runningViaConvenienceMethod = await store.listRunningStreamIds();

// Shutdown cleanup (idempotent)
store.close();
```

For full API details and patterns, see:
`apps/docs/app/docs/context/stream-persistence.mdx`

## License

MIT
