# @deepagents/context

A domain-agnostic context management system for formatting context fragments into different prompt styles.

## Overview

This package provides a simple and flexible way to render context data in multiple formats (XML, Markdown, TOML). Context fragments are simple data structures that can be transformed into different representations suitable for various LLM prompt styles.

## Installation

```bash
npm install @deepagents/context
```

## Basic Usage

```typescript
import {
  MarkdownRenderer,
  TomlRenderer,
  XmlRenderer,
} from '@deepagents/context';
import type { ContextFragment } from '@deepagents/context';

// Define your context fragments
const fragments: ContextFragment[] = [
  {
    name: 'styleGuide',
    data: {
      prefer: 'CTEs',
      never: 'subqueries',
      indentation: 2,
    },
  },
];

// Render in different formats
const xmlRenderer = new XmlRenderer();
console.log(xmlRenderer.render(fragments));

const mdRenderer = new MarkdownRenderer();
console.log(mdRenderer.render(fragments));

const tomlRenderer = new TomlRenderer();
console.log(tomlRenderer.render(fragments));
```

## Renderers

### XmlRenderer

Renders fragments as XML with proper nesting and escaping:

```xml
<styleGuide>
  <prefer>CTEs</prefer>
  <never>subqueries</never>
  <indentation>2</indentation>
</styleGuide>
```

**Features:**

- Automatic XML escaping for special characters
- Nested object support
- Array handling with singular form tags
- Proper indentation

### MarkdownRenderer

Renders fragments as Markdown with bullet points:

```markdown
## Style Guide

- **prefer**: CTEs
- **never**: subqueries
- **indentation**: 2
```

**Features:**

- Automatic title case conversion for fragment names
- Nested structures with proper indentation
- Array items as bullet points
- Bold keys for readability

### TomlRenderer

Renders fragments as TOML-like format:

```toml
[styleGuide]
prefer = "CTEs"
never = "subqueries"
indentation = 2
```

**Features:**

- TOML section headers
- Nested objects as subsections
- Array support with proper formatting
- String escaping for quotes and backslashes

## Handling Complex Data

### Arrays

```typescript
const fragment = {
  name: 'workflow',
  data: {
    task: 'Analysis',
    steps: ['step1', 'step2', 'step3'],
  },
};
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

**Markdown Output:**

```markdown
## Workflow

- **task**: Analysis
- **steps**:
  - step1
  - step2
  - step3
```

**TOML Output:**

```toml
[workflow]
task = "Analysis"
steps = ["step1", "step2", "step3"]
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

**Markdown Output:**

```markdown
## Database

- **host**: localhost
- **settings**:
  - **timeout**: 30
  - **retry**: true
```

**TOML Output:**

```toml
[database]
host = "localhost"

[settings]
timeout = 30
retry = true
```

### Null and Undefined Values

All renderers automatically skip `null` and `undefined` values:

```typescript
const fragment = {
  name: 'config',
  data: {
    enabled: true,
    disabled: null, // Will be skipped
    missing: undefined, // Will be skipped
  },
};
```

## API Reference

### Interfaces

#### ContextFragment

```typescript
interface ContextFragment {
  name: string;
  data: Record<string, unknown>;
}
```

#### ContextRenderer

```typescript
interface ContextRenderer {
  render(fragments: ContextFragment[]): string;
}
```

### Classes

All renderer classes implement the `ContextRenderer` interface:

- `XmlRenderer` - Renders as XML
- `MarkdownRenderer` - Renders as Markdown
- `TomlRenderer` - Renders as TOML

Each class has a single public method:

```typescript
render(fragments: ContextFragment[]): string
```

## License

MIT
