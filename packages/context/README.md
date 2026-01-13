# @deepagents/context

A domain-agnostic context management system for formatting context fragments into different prompt styles.

## Overview

This package provides a flexible way to compose and render context data in multiple formats (XML, Markdown, TOML, TOON). Context fragments are simple data structures that can be transformed into different representations suitable for various LLM prompt styles.

## Installation

```bash
npm install @deepagents/context
```

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
    action: 'Aggregate data instead',
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
    <action>Aggregate data instead</action>
  </guardrail>
</guardrails>
```

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
| `userContext(description)`           | Current working focus        | `userContext('Q4 analysis')`                   |
| `correction(subject, clarification)` | Corrections to understanding | `correction('status', '1=active, 0=inactive')` |

### Core Utilities

| Function                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `fragment(name, ...children)` | Create a wrapper fragment with nested children |
| `role(content)`               | System role/instructions fragment              |

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

### Nested Objects

```typescript
const fragment = {
  name: 'database',
  data: {
    host: 'localhost',
    settings: {
      timeout: 30,
      retry: true,
    },
  },
};
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
  data: FragmentData;
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

## License

MIT
