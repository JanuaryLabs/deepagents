# UI Component Topology

Status: current-source inventory after the devtool package split and the
approved Limerence sidebar port.

## Conclusion

The devtool now owns three publishable UI packages plus its host shell. The repo
still has no cross-product `@deepagents/ui`, `@stdlib/ui`, or `@stdlib/shadcn`
package.

```text
deepagents
├── apps/docs
│   ├── fumadocs-ui layouts and document components
│   └── app-local editorial CSS
├── apps/evals-web-runner/frontend
│   ├── app/shadcn                 54 vendored primitive files
│   ├── app/components              6 cross-route compositions
│   └── app/routes                 product screens and route-local UI
└── packages/devtool
    ├── shadcn                      shared utilities, badge, sidebar, and theme CSS
    ├── history                     History compound composition and model
    ├── traces                      trace server core and trace React view
    └── host/ui/main.tsx            application shell and navigation
```

The eval runner is the only substantial in-repository component collection,
but it is an application implementation detail rather than a reusable package.
The devtool must not import through an app-owned path.

## UI modules

### `packages/devtool`

Ownership:

- [`../host/ui/src/main.tsx`](../host/ui/src/main.tsx) owns only the application
  shell, discovery/history polling, navigation, and conversation summary.
- [`../history/src/index.tsx`](../history/src/index.tsx) owns `History.Root`,
  `History.Item`, `History.ItemTrigger`, `History.Empty`, `HistoryStatusIcon`,
  and the `HistoryRecord` model.
- [`../traces/src/index.ts`](../traces/src/index.ts) owns trace discovery,
  telemetry decoration, and HTTP routes;
  [`../traces/src/ui.tsx`](../traces/src/ui.tsx) owns the waterfall and inspector.
- [`../shadcn/src/index.ts`](../shadcn/src/index.ts) owns `cn()` and timestamp
  formatting; [`../shadcn/src/status-badge.tsx`](../shadcn/src/status-badge.tsx)
  owns the shared badge; [`../shadcn/src/sidebar.tsx`](../shadcn/src/sidebar.tsx)
  owns the Limerence-derived off-canvas sidebar contract, and
  [`../shadcn/src/styles.css`](../shadcn/src/styles.css) owns the Tailwind theme.
- [`../host/ui/vite.config.ts`](../host/ui/vite.config.ts) builds the UI into static
  assets copied into the published `@deepagents/devtool` package.

Current dependencies are React, Tailwind CSS, Lucide, Radix Dialog, `clsx`, and
`tailwind-merge`. Radix Dialog is used only for the responsive sidebar sheet.
The existing public integration test exercises the server/package interface;
CSS-rule comparison proves the relocation preserved all 168 generated
selectors and declarations.

Implication: scheduled-task UI belongs in feature packages, while only proven
Limerence components should enter the existing `shadcn` package.

### `apps/evals-web-runner/frontend`

Ownership:

- [`../../../apps/evals-web-runner/frontend/src/app/shadcn/index.ts`](../../../apps/evals-web-runner/frontend/src/app/shadcn/index.ts)
  exports an app-local collection of 54 shadcn-derived primitive files.
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
| `TheButton`              |                     1 | One async dataset import action              |
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
describes generated hooks in `packages/ui`, `TheButton` in `@stdlib/ui`, and
shadcn exports in `packages/stdlib/shadcn`. None of those packages exist in
this checkout. Actual imports resolve to app-local hooks and
`app/shadcn/index.ts`.

This drift must not be treated as proof that a reusable component package
already exists.

## Limerence reuse seam

The source inventory selected the following seam:

1. inventory the actual Limerence component source, package exports, tokens,
   fonts, assets, primitive system, and dependency footprint;
2. map only the scheduled-task wireframe needs to those existing components;
3. choose the seam from demonstrated consumers:
   - consume an existing Limerence package if it is already a stable package;
   - add selected Limerence components to `packages/devtool/shadcn` when they
     are needed by an approved devtool screen;
   - otherwise leave them in their current owner;
4. keep theme tokens app-owned unless both consumers demonstrably share the
   same product theme;
5. add no parallel primitive system and do not import from one application
   into another.

The Limerence source is `packages/stdlib/shadcn/src/lib/ui/sidebar.tsx`, composed
by `apps/desktop/frontend/src/app/routes/Layout/Layout.tsx`. The approved port
includes the behavior the devtool shell uses: provider state, desktop
off-canvas transition, inset restore trigger, rail, Ctrl/Cmd+B shortcut,
cookie persistence, and the responsive Radix sheet. The host continues to own
navigation and records. No application-owned import or second primitive system
is introduced.
