## Writing Documentation Pages

### Frontmatter

Every `.mdx` file uses exactly two frontmatter fields:

```yaml
---
title: Page Title
description: One-sentence summary
---
```

`DocsTitle` and `DocsDescription` in `routes/docs.tsx` render these automatically as the page heading and lead paragraph. **Never** repeat them in the body:

```mdx
## <!-- WRONG: duplicates frontmatter -->

title: Configuration
description: Environment variables and configuration options

---

# Configuration

All settings are environment variables.

## <!-- RIGHT: body starts directly with content -->

title: Configuration
description: Environment variables and configuration options

---

## Required

| Variable | Description |
| -------- | ----------- |
```

### Headings

- No `#` (H1) in the body — `DocsTitle` is the H1
- Start body content at `##` (H2)
- Max depth `###` (H3) for subsections
- Custom anchor: `## My Heading [#custom-id]`
- Hide from TOC: `## Internal Heading [!toc]`

### Fumadocs Components

Prefer built-in components over raw HTML. Already available via `defaultMdxComponents`:

**Callout** — info, warn, error, success

```mdx
<Callout type="warn" title="Optional Title">
  Content here.
</Callout>
```

**Cards** — linked navigation cards

```mdx
<Cards>
  <Card title="Getting Started" href="/docs/getting-started" />
</Cards>
```

Explicitly imported in `docs.tsx` and available in MDX:

**Tabs** — tabbed content panels

```mdx
<Tabs items={['npm', 'yarn']}>
  <Tab value="npm">npm install</Tab>
  <Tab value="yarn">yarn add</Tab>
</Tabs>
```

Available but require import in the MDX file:

**Steps** — numbered procedure steps

```mdx
import { Step, Steps } from 'fumadocs-ui/components/steps';

<Steps>
  <Step>### Install Dependencies</Step>
  <Step>### Configure</Step>
</Steps>
```

**Accordion** — collapsible sections

```mdx
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';

<Accordions>
  <Accordion title="Question">Answer</Accordion>
</Accordions>
```

**Files** — file tree visualization

```mdx
import { File, Files, Folder } from 'fumadocs-ui/components/files';

<Files>
  <Folder name="app" defaultOpen>
    <File name="page.tsx" />
  </Folder>
</Files>
```

**TypeTable** — API/config property tables

```mdx
import { TypeTable } from 'fumadocs-ui/components/type-table';

<TypeTable
  type={{
    name: { type: 'string', description: 'Display name', required: true },
  }}
/>
```

### Code Blocks

Use Fumadocs code block features instead of custom markup:

- Title: ` ```ts title="config.ts" `
- Line numbers: ` ```ts lineNumbers `
- Highlight: append `// [!code highlight]` to a line
- Diff: `// [!code ++]` and `// [!code --]`
- Focus: `// [!code focus]`
- Tabbed code blocks: ` ```ts tab="TypeScript" ` — consecutive tab blocks merge automatically
- Package manager tabs: use ` ```npm ` language — auto-generates npm/pnpm/yarn/bun tabs

### Content Patterns

- **Tables** for reference data (env vars, API props, config options)
- **Numbered lists** (`1. 2. 3.`) for sequential procedures
- **Bold** for UI paths: `**Settings → Embed**`
- **Code fences** always have a language tag (`bash`, `yaml`, `ts`, `html`)
- **Index pages** are shallow overviews linking to sub-pages, not detailed content

### Links

- Internal links: `[Page Title](/docs/path)` or relative `[Page](./sibling)`
- External links get `target="_blank"` automatically
- Bare URLs auto-link
