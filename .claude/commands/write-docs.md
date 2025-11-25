---
description: Generate documentation for a package by analyzing source code
allowed-tools: Read, Glob, Grep, Bash(ls:*), Task
argument-hint: "<package-name>"
---

# Write Documentation for Package

Analyze the package at `packages/$ARGUMENTS/` and generate comprehensive documentation.

## Steps

1. **Explore the package source code** at `packages/$ARGUMENTS/src/`
   - Read the main entry point `packages/$ARGUMENTS/src/index.ts`
   - Identify all public exports (classes, functions, types)
   - Understand the package's purpose and architecture

2. **Identify documentation pages needed**
   - Overview/introduction page
   - Getting started guide
   - One page per major feature or component
   - Group related items (e.g., adapters, agents)

3. **For each page, spawn a doc-writer sub-agent IN PARALLEL**
   Use the Task tool with `subagent_type: "doc-writer"` for each page:
   ```
   Task({
     subagent_type: "doc-writer",
     prompt: "Write documentation for [topic] in package $ARGUMENTS.
              Source files: [list relevant source files]
              Output file: apps/docs/app/docs/$ARGUMENTS/[page-name].mdx"
   })
   ```

4. **Create/update `apps/docs/app/docs/$ARGUMENTS/meta.json`**
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

## Output Format

- All pages go in `apps/docs/app/docs/$ARGUMENTS/`
- Each page is an MDX file with YAML frontmatter:
  ```mdx
  ---
  title: Page Title
  description: Brief description for SEO
  ---

  # Page Title

  Content here...
  ```
- Use `---Label---` syntax in meta.json for section separators
- Order pages logically: overview → getting started → core features → advanced

## Guidelines

- Use clear, concise language
- Include code examples from actual source
- Use tables for API reference-style listings
- Add "Next Steps" sections linking related pages
- Follow existing documentation style in apps/docs/
