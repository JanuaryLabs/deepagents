---
name: write-docs
description: Generate documentation for a package by analyzing source code. Use when the user wants to write, create, or generate new documentation pages for a package from scratch.
---

# Write Documentation for Package

Analyze a package's source code and generate comprehensive documentation pages.

## Steps

### 1. Explore the Package Source Code

At `packages/<package-name>/src/`:

- Read main entry point `index.ts`
- Identify all public exports (classes, functions, types)
- Understand the package's purpose and architecture

### 2. Identify Documentation Pages Needed

- Overview/introduction page
- Getting started guide
- One page per major feature or component
- Group related items (e.g., adapters, agents)

### 3. For Each Page, Spawn a doc-writer Sub-Agent IN PARALLEL

Use the Task tool with `subagent_type: "doc-writer"` for each page:

```
Task({
  subagent_type: "doc-writer",
  prompt: "Write documentation for [topic] in package <package-name>.
           Source files: [list relevant source files]
           Output file: apps/docs/app/docs/<package-name>/[page-name].mdx"
})
```

### 4. Create/Update meta.json

At `apps/docs/app/docs/<package-name>/meta.json`:

```json
{
  "title": "Package Name",
  "root": true,
  "pages": [
    "index",
    "getting-started",
    "---Section Name---",
    "page-1",
    "page-2"
  ]
}
```

- Use `---Label---` syntax for section separators
- Order pages: overview → getting started → core features → advanced

## Writing Style

- Read [prose.md](prose.md) for Fumadocs conventions (frontmatter, headings, components, code blocks, content patterns)
- Follow the `writing-clearly-and-concisely` skill for prose quality — concise, clear, no AI slop
