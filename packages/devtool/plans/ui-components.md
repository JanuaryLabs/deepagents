# UI component topology

Status: current source inventory after moving the shadcn/ui primitives to
`@zukhruf/shadcn` and `TheButton` to `@zukhruf/ui`.

## Conclusion

The repository uses `@zukhruf/shadcn` from npm for shared shadcn/ui primitives.
`@zukhruf/ui` supplies `TheButton`, built on those primitives. Applications
own their themes and feature compositions.

```text
deepagents
├── apps/docs
│   ├── fumadocs-ui layouts and document components
│   └── app-local editorial CSS
├── apps/evals-web-runner/frontend
│   ├── app/components              6 cross-route compositions
│   └── app/routes                 product screens and route-local UI
└── packages/devtool
    ├── history                     History composition, status, and formatting
    └── host
        ├── src/traces              trace reader, telemetry, and HTTP projection
        └── ui                      application shell, navigation, theme, and trace view
```

Both the eval runner and DevTool import primitives from `@zukhruf/shadcn`.
The chat snapshot action in
[`../../../packages/react/genai/src/lib/copy/assistant-snapshot.tsx`](../../../packages/react/genai/src/lib/copy/assistant-snapshot.tsx)
imports `TheButton` from `@zukhruf/ui`. Neither application imports through
the other's paths.

## UI modules

### `packages/devtool`

Ownership:

- [`../host/ui/src/main.tsx`](../host/ui/src/main.tsx),
  [`../host/ui/src/router.tsx`](../host/ui/src/router.tsx), and
  [`../host/ui/src/app`](../host/ui/src/app) own the application shell,
  capability discovery, routing, navigation, and shared application state.
- [`../host/ui/src/routes/scheduled.tsx`](../host/ui/src/routes/scheduled.tsx)
  and [`../host/ui/src/app/schedules-data.ts`](../host/ui/src/app/schedules-data.ts)
  own the capability-gated Scheduled workspace and its data access.
- [`../history/src/index.tsx`](../history/src/index.tsx) owns `History.Root`,
  `History.Item`, `History.ItemTrigger`, `History.Empty`, `ChatStatusIcon`,
  `RuntimeEventsProvider`, and the `HistoryRecord` model.
- [`../host/src/traces/index.ts`](../host/src/traces/index.ts) exports trace
  integration through `@deepagents/devtool/traces`, including telemetry
  recording, the trace reader, and HTTP routes.
  [`../host/ui/src/traces/view.tsx`](../host/ui/src/traces/view.tsx) owns the
  waterfall and inspector.
- `@zukhruf/shadcn` exports the Base UI-backed primitive set; `cn()` comes
  from the `cn` package.
- [`../history/src/index.tsx`](../history/src/index.tsx) owns status presentation
  and timestamp formatting.
- [`../host/ui/src/styles.css`](../host/ui/src/styles.css) owns the DevTool
  Tailwind theme.
- [`../host/ui/vite.config.ts`](../host/ui/vite.config.ts) builds the UI into static
  assets copied into the published `@deepagents/devtool` package.

The existing public integration test exercises the server/package interface.
The shared sidebar preserves provider state, desktop off-canvas behavior,
inset restore trigger, rail, Ctrl/Cmd+B, cookie persistence, and a responsive
sheet.

Scheduled-task composition remains in the DevTool host. Shared shadcn/ui
primitives come from `@zukhruf/shadcn`. The shell imports `SIDEBAR_COOKIE_NAME`
from that package to restore the sidebar state saved by `SidebarProvider`.

### `apps/evals-web-runner/frontend`

Ownership:

- `@zukhruf/shadcn` supplies the eval runner's primitives.
- [`../../../apps/evals-web-runner/frontend/src/app/components`](../../../apps/evals-web-runner/frontend/src/app/components)
  contains six compositions shared by more than one route or too substantial
  to leave inline.
- [`../../../apps/evals-web-runner/frontend/src/app/routes`](../../../apps/evals-web-runner/frontend/src/app/routes)
  contains product screens. Route-only subcomponents remain colocated.
- [`../../../apps/evals-web-runner/frontend/src/styles.css`](../../../apps/evals-web-runner/frontend/src/styles.css)
  owns its Tailwind theme.

Direct primitive usage by breadth:

| Primitive family         | Direct consumer files | Current role                                 |
| ------------------------ | --------------------: | -------------------------------------------- |
| Button                   |                    10 | Actions across every product area            |
| Table                    |                    10 | Datasets, runs, suites, prompts, comparisons |
| Skeleton                 |                    10 | Page and section loading states              |
| Card                     |                     5 | Statistics and comparison groups             |
| Input                    |                     5 | Filters and forms                            |
| Badge                    |                     4 | Status and labels                            |
| Breadcrumb               |                     3 | Detail-page navigation                       |
| Select                   |                     3 | Model, dataset, and comparison choices       |
| Progress                 |                     3 | Run and suite progress                       |
| Checkbox                 |                     2 | Eval and suite selection                     |
| Textarea                 |                     2 | Prompt/eval authoring                        |
| Accordion, Tabs, Sidebar |                1 each | One specialized screen or shell              |
| Command + Dialog         |                     1 | `ModelSelector` composition                  |
| Chart                    |                     1 | `SuiteComparison` composition                |
| Toaster                  |                     1 | Root feedback host                           |

Cross-route compositions and callers:

| Composition       | Callers                            |
| ----------------- | ---------------------------------- |
| `CaseTable`       | Run detail                         |
| `ComparisonTable` | Compare page                       |
| `ModelSelector`   | New-eval page                      |
| `RunStatusBadge`  | Run list, run detail, suite detail |
| `StatsGrid`       | Run detail                         |
| `SuiteComparison` | Suite detail                       |

The eval runner and DevTool inherit shared theme defaults from
`@zukhruf/shadcn/styles.css` and define their own font and color overrides.
Their token names are compatible; each application owns its theme values.

### `apps/docs`

[`../../../apps/docs/app`](../../../apps/docs/app) uses `fumadocs-ui` layouts,
tabs, code blocks, page components, and providers. Its local components are
documentation-specific (`PackageCard`, `FeatureBlock`, and navigation), and
[`../../../apps/docs/styles.css`](../../../apps/docs/styles.css) owns a separate
editorial theme.

The docs UI owns documentation components; DevTool management compositions
remain in the DevTool packages.

## Documentation drift

[`../../../apps/evals-web-runner/AGENTS.md`](../../../apps/evals-web-runner/AGENTS.md)
now points UI work to `@zukhruf/shadcn`. Generated data hooks remain
app-local.

## Shared package boundary

The package boundary uses these constraints:

1. Import primitives from `@zukhruf/shadcn` and `cn` from `cn`.
2. Keep feature compositions in their owning application or feature package;
   the shared package contains shadcn/ui primitives.
3. Import `@zukhruf/shadcn/styles.css` after Tailwind with a plain `@import`,
   without `layer()`. Apps rendering `@deepagents/react-genai` also import
   `@zukhruf/ui/styles.css`, as the DevTool host does. Each application's
   stylesheet owns its theme overrides.
4. Keep navigation as `Link` or `NavLink`, styled with
   `cn(buttonVariants(...))`. Use `Button` for actions.
5. Keep theme tokens app-owned unless both consumers demonstrably share the
   same product theme. Use the shared primitives without vendoring copies or
   introducing a parallel primitive system. Do not import from one application
   into another.

The DevTool host continues to own navigation and records, and the eval runner
continues to own its product screens. Their themes remain intentionally
different.
