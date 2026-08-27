# UI Component Topology

Status: current-source inventory after consolidating Shadcn primitives into
`@deepagents/react-shadcn`.

## Conclusion

The repo has one cross-product Shadcn package:
`@deepagents/react-shadcn`. Applications own their themes and feature
compositions; they do not vendor primitive copies.

```text
deepagents
├── apps/docs
│   ├── fumadocs-ui layouts and document components
│   └── app-local editorial CSS
├── apps/evals-web-runner/frontend
│   ├── app/components              6 cross-route compositions
│   └── app/routes                 product screens and route-local UI
├── packages/react/shadcn           Base UI-backed shared primitives
└── packages/devtool
    ├── history                     History composition, status, and formatting
    ├── traces                      trace server core and trace React view
    └── host/ui                     application shell, navigation, and theme
```

Both the eval runner and devtool import primitives from the shared package.
Neither imports through the other application's paths.

## UI modules

### `packages/devtool`

Ownership:

- [`../host/ui/src/main.tsx`](../host/ui/src/main.tsx),
  [`../host/ui/src/router.tsx`](../host/ui/src/router.tsx), and
  [`../host/ui/src/app`](../host/ui/src/app) own the application shell,
  discovery/history polling, routing, navigation, and placeholder Scheduled
  route.
- [`../history/src/index.tsx`](../history/src/index.tsx) owns `History.Root`,
  `History.Item`, `History.ItemTrigger`, `History.Empty`, `HistoryStatusIcon`,
  and the `HistoryRecord` model.
- [`../traces/src/index.ts`](../traces/src/index.ts) owns trace discovery,
  telemetry decoration, and HTTP routes;
  [`../traces/src/ui.tsx`](../traces/src/ui.tsx) owns the waterfall and inspector.
- [`../../react/shadcn/src/index.ts`](../../react/shadcn/src/index.ts) exports
  `cn()` and the shared Base UI-backed primitive set.
- [`../history/src/index.tsx`](../history/src/index.tsx) owns status presentation
  and timestamp formatting.
- [`../host/ui/src/styles.css`](../host/ui/src/styles.css) owns the devtool
  Tailwind theme.
- [`../host/ui/vite.config.ts`](../host/ui/vite.config.ts) builds the UI into static
  assets copied into the published `@deepagents/devtool` package.

The existing public integration test exercises the server/package interface.
The shared sidebar preserves provider state, desktop off-canvas behavior,
inset restore trigger, rail, Ctrl/Cmd+B, cookie persistence, and a responsive
sheet.

Implication: scheduled-task UI belongs in feature packages, while only proven
cross-product primitives should enter `@deepagents/react-shadcn`.

### `apps/evals-web-runner/frontend`

Ownership:

- [`../../react/shadcn/src/index.ts`](../../react/shadcn/src/index.ts) supplies
  the eval runner's shared primitives.
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

The eval runner and devtool share 72 CSS custom-property names, but many values
differ. Their token schemas are compatible; their themes are not identical.
Shared behavior and app-owned theme values are therefore separable.

### `apps/docs`

[`../../../apps/docs/app`](../../../apps/docs/app) uses `fumadocs-ui` layouts,
tabs, code blocks, page components, and providers. Its local components are
documentation-specific (`PackageCard`, `FeatureBlock`, and navigation), and
[`../../../apps/docs/styles.css`](../../../apps/docs/styles.css) owns a separate
editorial theme.

Implication: the docs UI is not a source for devtool management primitives.

## Documentation drift

[`../../../apps/evals-web-runner/AGENTS.md`](../../../apps/evals-web-runner/AGENTS.md)
now points UI work to `@deepagents/react-shadcn`. Generated data hooks remain
app-local.

## Shared package seam

The package boundary uses these constraints:

1. import primitives and `cn` from `@deepagents/react-shadcn`;
2. keep feature compositions in their owning application or feature package;
3. add primitives to the shared package only after a demonstrated consumer;
4. keep theme tokens app-owned unless both consumers demonstrably share the
   same product theme;
5. add no parallel primitive system and do not import from one application
   into another.

The devtool host continues to own navigation and records, and the eval runner
continues to own its product screens. Their themes remain intentionally
different.
