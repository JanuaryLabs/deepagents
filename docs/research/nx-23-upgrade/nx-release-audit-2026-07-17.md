# Nx 21.6.4 to 23.1.0 Upgrade and Adoption Audit

Research date: 2026-07-17  
Workspace: `deepagents`  
Starting version: Nx 21.6.4, with an unsupported `@nx/vitest` 22.6.4 exception  
Implemented version: Nx 23.1.0

## Executive Summary

The workspace has been migrated from Nx 21.6.4 to Nx 23.1.0, the latest stable release available on 2026-07-17. Every direct `nx` and `@nx/*` package is pinned to exactly 23.1.0, restoring the version alignment required by Nx. The scope was then widened from Nx alone to **every direct npm dependency in every checked-in workspace**. The refreshed graph includes Vite 8.1.5, TypeScript 6.0.3, React Router 8.2.0, React 19.2.7, ESLint 10.7.0, Zod 4.4.3, LangChain 1.5.3, AI SDK 7.0.30, SDK-IT 0.45.0, and Tailwind CSS 4.3.3. TypeScript is the one deliberate major-version hold: the repository uses the latest 6.x release instead of TypeScript 7. A second non-npm inventory moved all 11 GitHub Action references across the three workflows to the latest published majors: checkout/setup-node 7, nx-set-shas 5, JUnit report 6, configure-pages 6, and Pages upload/deploy 5. [29][30][31][32][33][34][35]

The latest-major cutover required real source and configuration migrations rather than peer suppression: Vite now uses its built-in TypeScript path resolver, React Compiler runs through Rolldown's Babel bridge, React Router server context uses `RouterContextProvider`, LangChain text splitters use their dedicated package, and Zod/React Day Picker call sites follow their current APIs. `legacy-peer-deps=true` was removed. The compiler CLI and JavaScript compiler API now both come from the single `typescript@6.0.3` package, avoiding the TypeScript 7 native/API split. [21][22][23][24][25][26][27][28]

The research scope covers all 57 stable Nx releases after 21.6.4: seven 21.6 patches, 44 releases across Nx 22.0–22.7, and six releases across Nx 23.0–23.1. Nx 22 concentrated on large-workspace performance, a redesigned terminal experience, release tooling, plugin modernization, worktree-aware caching, and the first task-sandboxing capability. Nx 23 raised the Node floor to 22, added agent-assisted migrations, made task sandboxing a headline capability, promoted .NET support, improved TypeScript configuration loading and startup time, and continued replacing explicit executors with inferred tasks. [3][4][5]

The final upgraded workspace verifies cleanly: `nx sync:check` passes, all 12 build targets pass, all six test targets pass, and all 12 typecheck targets pass. The frontend's generated SDK initially exposed OpenAPI type drift, but its normal SDK generation step refreshed the artifact and the final full typecheck went green. The deprecated explicit Vitest executor was converted to an inferred target and reverified, removing the known Nx 24 migration blocker. A cold-checkout docs failure was also reproduced and fixed by making cached React Router type generation an explicit dependency of `docs:typecheck`. The remaining work is ecosystem cleanup, not a broken upgrade: finish ownership of the frontend SDK and test-report prerequisites, split the 1.75 MB frontend entry chunk, and track upstream peer metadata and security fixes without downgrading current packages.

## Introduction

### Question and scope

This audit answers three questions:

1. Can the repository move safely from its current Nx version to the latest stable Nx release?
2. What stable Nx releases and material capabilities shipped between those versions?
3. Which of those capabilities should this repository adopt now, evaluate later, or explicitly ignore?

“Everything released” is defined as every stable version in the interval `(21.6.4, 23.1.0]`, plus the material features, migrations, deprecations, and breaking changes documented in the official changelog, major/minor release announcements, and GitHub release tags. Prereleases, canaries, and unrelated Nx Cloud service announcements are excluded. The complete stable-version ledger appears later in this report.

Nx documents a six-month major-release cadence and recommends using `nx migrate` rather than treating a major upgrade as a normal package bump. It also requires `nx` and all first-party `@nx/*` packages to use matching versions. [1][2][18] The starting workspace violated that alignment because `@nx/vitest` was already on 22.6.4 while the rest of Nx was on 21.6.4. The migration therefore fixes both version age and an unsupported mixed-version graph.

### Repository context

The repository is an npm workspaces monorepo with 12 build/typecheck projects and six test projects. It uses inferred Nx plugins for ESLint, TypeScript, React Router, Vite, and Vitest, plus explicit project targets for package builds and integration-heavy Node test suites. It does not currently use Nx Cloud or remote caching. The declared Node policy is the latest LTS line; verification used Node 24.11.1, which satisfies Nx 23’s Node 22 minimum. [5][16]

## Main Analysis

### 1. The upgrade is an Nx 23 cutover, not a mixed compatibility bridge

The package manifest now pins `nx`, `@nx/esbuild`, `@nx/eslint`, `@nx/eslint-plugin`, `@nx/js`, `@nx/node`, `@nx/react`, `@nx/vite`, `@nx/vitest`, and `@nx/web` to exactly 23.1.0. This follows Nx’s package-alignment rule and avoids the starting state’s unsupported 21/22 mixture. [2]

The official migration made these durable configuration changes:

- `releaseTagPattern` became `releaseTag.pattern`, matching the newer release schema.
- `@nx/vitest` is registered as its own inferred-task plugin; `@nx/vite/plugin` no longer owns the Vitest target name.
- Redundant root TypeScript project references were removed from package and application `tsconfig.json` files.
- `.nx/self-healing` and local agent-worktree output were added to ignore files.
- The wider dependency refresh then moved React Router to 8.2.0, Vitest to 4.1.10, ESLint to 10.7.0, and every other direct dependency to its current stable dist-tag.
- `react-is` 19.2.7 became an explicit frontend dependency because Recharts declares it as a peer. Nx 21/Jest had previously supplied an accidental React 18 transitive copy, while the repository's former `legacy-peer-deps` setting hid the missing direct peer.

The migration did not keep generated migration plans or AI prompt files in the final change. Those files are execution artifacts, not runtime configuration.

### 2. The companion ecosystem is also on its latest stable majors

The final implementation deliberately accepts current-major friction across the refreshed toolchain, with TypeScript as the explicit exception. Vite 8.1.5 replaces Vite 7; `@vitejs/plugin-react` 6.0.3 uses Oxc for the normal transform path; React Compiler runs through `@rolldown/plugin-babel`; and Vite's built-in `resolve.tsconfigPaths` replaces `vite-tsconfig-paths`. Vite 8's unified Rolldown pipeline also unlocks its DevTools, browser-console forwarding, WebAssembly SSR support, and experimental 8.1 bundled-dev and chunk-import-map work for later evaluation. [21][22]

TypeScript is pinned directly to `typescript@6.0.3`, the latest 6.x release. The same package provides `tsc`, `tsserver`, and the JavaScript compiler API consumed by Nx and SDK generators; the TypeScript 7 native package and the temporary TypeScript 6 API alias are not installed. TypeScript 7 remains a future upgrade once the repository is ready for its native/API boundary. [23]

The same rule was applied beyond build tooling:

- React Router 8.2.0 required Node 22+, React 19.2.7+, ESM, and replacing `AppLoadContext` with `RouterContextProvider`. [24]
- Zod 4.4.3 required updating issue serialization and makes registries, metadata, JSON Schema, pretty errors, i18n, file schemas, template literals, and Zod Mini available. [25]
- LangChain 1.5.3 moved text splitters to `@langchain/textsplitters`; its new `createAgent` and normalized content blocks are available where interoperability is useful, without replacing DeepAgents' own agent abstraction. [26]
- AI SDK 7.0.30 makes runtime/tool contexts, provider files and skills, approvals, workflow agents, sandboxing, timeouts, lifecycle statistics, MCP Apps/TUI, realtime, and video APIs available for targeted adoption. [27]
- ESLint 10.7.0 moves the workspace to flat-config-only behavior and the current rules engine. Its new recommended rules should be enabled only after reviewing their repo-specific findings. [28]

Some latest packages still publish peer ranges that stop at the previous major: several ESLint plugins name ESLint 9, VitePress bundles older Vite/plugin-vue and React peer metadata, and Babel/Jest/Nx packages still name Babel 7. Those are recorded as upstream metadata gaps because builds, tests, and typechecks pass on the installed graph. They are not hidden with `legacy-peer-deps`; SDK-IT's TypeScript peer range is satisfied by the TypeScript 6.0.3 decision.

### 3. Nx 22 delivered most of the operational improvements relevant here

Nx 22 introduced a graph implementation intended for very large workspaces, refined the terminal UI, expanded non-JavaScript support, added pnpm catalogs, and substantially evolved `nx release`. The release tooling gained a release graph, project filters, dependent-update controls, nested release-tag configuration, and richer changelog APIs. [3][8]

The 22.x minors then added capabilities incrementally:

- 22.1 added Windows terminal UI support and current framework/plugin compatibility, including the standalone `@nx/vitest` plugin. [9]
- 22.2 added Expo 54, Nuxt 4, Storybook 10.1, and a Vitest 4 migration. [10]
- 22.3 added Angular 21 support, experimental `tsgo`, and Prettier 3 updates. [11]
- 22.4 improved daemon reconnection, fullscreen terminal behavior, TypeScript dependency-build performance, Vitest configuration handling, and ESLint flat-config migrations. [12]
- 22.5 reduced task resource use, represented batch tasks in the terminal UI, added `nx list --json`, ESLint 10 support, AI-agent configuration, and Nx Cloud artifact decryption. [13]
- 22.6 introduced task sandboxing, `nx show target`, dependency filesets using `^{projectRoot}`, Vite 8 support, and Angular 21.2 support. [14]
- 22.7 made local caching worktree-aware, reduced daemon memory, accelerated cache replay, added JSON input typing, exposed target-source annotations, and added `NX_BAIL`. Nx’s release article reports daemon memory falling from roughly 1.5 GB to roughly 200 MB in its large-workspace benchmark and cached replay of 1,110 tasks improving from roughly 17 seconds to 1.16 seconds. [4][15]

The workspace receives the graph, daemon, cache replay, and worktree improvements automatically by running Nx 23. No configuration or Nx Cloud subscription is required for those local benefits.

### 4. Nx 23 changes the platform floor and the migration model

Nx 23 requires Node 22 or newer, adds agent-assisted migrations, makes task sandboxing a major workflow, promotes `@nx/dotnet` to general availability, loads TypeScript configuration natively, uses V8 compile caching, and adds shell completion. [5][16]

It also continues the inferred-task transition. First-party plugins increasingly derive targets from tool configuration instead of requiring executor blocks in every `project.json`. Nx 23 tightens package exports, renames the plugin `createNodesV2` API to `createNodes`, deprecates several helper APIs, and deprecates magic strings in `dependsOn`. Target defaults gain a spread token for composition; 23.1 extends filtered target defaults with nested arrays. [5][16][17]

For this repository, the immediately actionable deprecation was the frontend `@nx/vitest:test` executor, which Nx removes in Nx 24. The official `@nx/vitest:convert-to-inferred` generator has now removed that executor, retained the frontend-specific coverage and no-tests behavior as target overrides, and preserved the root `test -> build` dependency. `frontend:test` passes through the inferred target without the deprecation warning.

### 5. Nx 23.1 improves diagnosis and current framework support

Nx 23.1 adds Angular 22 support, a performance summary after task runs, nested arrays for filtered target defaults, mouse support in the terminal UI, TypeScript 6 migration corrections, configurable TypeScript path handling in Vite build/test flows, and additional hashing and cache fixes. It also detects Codex-style sandboxes and can disable daemon/plugin isolation when the environment requires it. [17]

The new performance report is visible in this migration’s verification output. It identifies run duration, cache-hit ratio, critical path, and recoverable time without extra tooling. This is worth retaining in CI logs and can guide target splitting before adding a separate build-profiling system.

### 6. Verification separates Nx regressions from repository setup debt

The upgraded workspace produced these results:

| Check | Result | Notes |
|---|---|---|
| `nx report` | Pass | Node 24.11.1; all direct Nx packages 23.1.0; expected plugins registered |
| `nx sync:check` | Pass | Workspace and TypeScript synchronization are current |
| Direct dependency currency | Pass | `npm outdated` finds no real stale direct package; its sole `autoevals` result claims 0.0.132 while the registry's own `latest` dist-tag is 0.3.0, which is installed |
| GitHub Action currency | Pass | Seven unique actions/11 references use their latest published major tags across CI, release, and docs deployment [29][30][31][32][33][34][35] |
| Workflow validation | Pass | Current action inputs were checked against each release's `action.yml`; YAML parsing and actionlint schema/expression checks pass |
| Dependency installation | Pass with warnings | `npm install --ignore-scripts` succeeds without `legacy-peer-deps`; `autoevals` 0.3.0 declares pnpm-only engines, and the normal Husky prepare launcher is suspended by this managed macOS environment while its explicit Node entry point succeeds |
| Strict peer validation | Upstream follow-up | `npm ls --all` exposes latest-major metadata lag in SDK-IT/TypeScript, ESLint plugins, Babel/Jest/Nx, and VitePress; runtime verification below is green |
| Builds | 12/12 pass | Frontend, backend, docs, and all packages; frontend retains a large-chunk warning |
| Tests | 6/6 targets pass | Frontend, Experimental, Text2SQL, Context, Agent, and Evals |
| Typechecks | 12/12 pass | Frontend SDK generation refreshed the OpenAPI artifact before the final run |
| Audit | Improved; follow-up required | Non-breaking `npm audit fix` reduced 44 findings to 27: 9 low, 14 moderate, 4 high, 0 critical |

Some clean-worktree prerequisites surfaced during verification:

- Test reporters assume `test-results/` already exists.
- Frontend build/typecheck depends on a generated `.evals-sdk-it` workspace and a post-generation npm link; the final normal test/typecheck flow proves that generation path works.
- Docs typecheck previously required a manual React Router type-generation step. It now owns a cached `docs:typegen` dependency and passes from a deliberately cold generated state.
- Fresh native binaries under this managed macOS worktree can be delayed by provenance/security scanning. Backend esbuild verification passed immediately when the same installed binary was copied to `/private/tmp` and selected through `ESBUILD_BINARY_PATH`; this changed no source or dependency version.

These are not evidence that Nx 23 is broken, but they are reproducibility gaps worth fixing in target dependencies. The remaining audit roots are also explicit: `xlsx` has no fixed npm-registry release; VitePress bundles an advisory-affected older Vite; FastEmbed reaches vulnerable `tar`; Verdaccio reaches vulnerable `qs`/`uuid`/`js-yaml`; and secure-exec/node-polyfill chains retain low-severity browser shims. npm's suggested `--force` actions would downgrade latest direct packages, so they were rejected.

## Complete Stable Release Ledger

The table includes every stable Nx release after 21.6.4 through 23.1.0. Patch rows are classified as maintenance releases unless the official tag promoted a separately documented feature. Every row links to the corresponding official GitHub release tag; the minor-level capability synthesis above is based on the official changelog and release articles. [1][3][4][5]

| Version | Published | Release scope | Official tag |
|---|---:|---|---|
| 21.6.5 | 2025-10-15 | 21.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/21.6.5) |
| 21.6.6 | 2025-10-21 | 21.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/21.6.6) |
| 22.0.0 | 2025-10-22 | Major: graph/TUI/release/plugin modernization and breaking removals | [tag](https://github.com/nrwl/nx/releases/tag/22.0.0) |
| 22.0.1 | 2025-10-22 | 22.0 launch fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.0.1) |
| 21.6.7 | 2025-10-28 | 21.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/21.6.7) |
| 22.0.2 | 2025-10-28 | 22.0 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.0.2) |
| 21.6.8 | 2025-10-30 | 21.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/21.6.8) |
| 22.0.3 | 2025-11-10 | 22.0 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.0.3) |
| 22.0.4 | 2025-11-17 | 22.0 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.0.4) |
| 21.6.9 | 2025-11-18 | 21.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/21.6.9) |
| 22.1.0 | 2025-11-19 | Windows TUI; Next 16, Storybook 10, Vitest 4, Cypress 15; `@nx/vitest` | [tag](https://github.com/nrwl/nx/releases/tag/22.1.0) |
| 22.1.1 | 2025-11-21 | 22.1 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.1.1) |
| 22.1.2 | 2025-11-25 | 22.1 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.1.2) |
| 21.6.10 | 2025-11-27 | 21.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/21.6.10) |
| 22.1.3 | 2025-11-27 | 22.1 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.1.3) |
| 22.2.0 | 2025-12-08 | Expo 54, Nuxt 4, Storybook 10.1, Vitest 4 migration | [tag](https://github.com/nrwl/nx/releases/tag/22.2.0) |
| 22.2.1 | 2025-12-11 | 22.2 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.2.1) |
| 22.2.2 | 2025-12-12 | 22.2 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.2.2) |
| 22.2.3 | 2025-12-12 | 22.2 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.2.3) |
| 22.2.4 | 2025-12-15 | 22.2 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.2.4) |
| 22.2.5 | 2025-12-15 | 22.2 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.2.5) |
| 22.2.6 | 2025-12-16 | 22.2 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.2.6) |
| 22.2.7 | 2025-12-16 | 22.2 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.2.7) |
| 22.3.0 | 2025-12-17 | Angular 21, experimental `tsgo`, Prettier 3 | [tag](https://github.com/nrwl/nx/releases/tag/22.3.0) |
| 22.3.1 | 2025-12-18 | 22.3 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.3.1) |
| 22.3.2 | 2025-12-19 | 22.3 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.3.2) |
| 22.3.3 | 2025-12-19 | 22.3 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.3.3) |
| 22.4.0 | 2026-01-21 | Daemon/TUI stability, TypeScript build performance, Vitest and ESLint migrations | [tag](https://github.com/nrwl/nx/releases/tag/22.4.0) |
| 22.4.1 | 2026-01-22 | 22.4 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.4.1) |
| 22.4.2 | 2026-01-26 | 22.4 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.4.2) |
| 22.4.3 | 2026-01-29 | 22.4 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.4.3) |
| 22.4.4 | 2026-01-30 | 22.4 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.4.4) |
| 22.4.5 | 2026-02-03 | 22.4 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.4.5) |
| 22.5.0 | 2026-02-09 | Resource reduction, batch-task TUI, `nx list --json`, ESLint 10, AI-agent setup | [tag](https://github.com/nrwl/nx/releases/tag/22.5.0) |
| 22.5.1 | 2026-02-13 | 22.5 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.5.1) |
| 22.5.2 | 2026-02-20 | 22.5 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.5.2) |
| 22.5.3 | 2026-02-26 | 22.5 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.5.3) |
| 22.5.4 | 2026-03-04 | 22.5 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.5.4) |
| 22.6.0 | 2026-03-18 | Task sandboxing, Vite 8, `nx show target`, dependency filesets | [tag](https://github.com/nrwl/nx/releases/tag/22.6.0) |
| 22.6.1 | 2026-03-20 | 22.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.6.1) |
| 22.6.2 | 2026-03-26 | 22.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.6.2) |
| 22.6.3 | 2026-03-27 | 22.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.6.3) |
| 22.6.4 | 2026-04-01 | 22.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.6.4) |
| 22.6.5 | 2026-04-10 | 22.6 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.6.5) |
| 21.6.11 | 2026-04-17 | Long-lived 21.6 maintenance release | [tag](https://github.com/nrwl/nx/releases/tag/21.6.11) |
| 22.7.0 | 2026-04-24 | Worktree cache, daemon/cache performance, typed inputs, source annotations, `NX_BAIL` | [tag](https://github.com/nrwl/nx/releases/tag/22.7.0) |
| 22.7.1 | 2026-04-28 | 22.7 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.7.1) |
| 22.7.2 | 2026-05-14 | 22.7 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.7.2) |
| 22.7.3 | 2026-05-22 | 22.7 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.7.3) |
| 22.7.4 | 2026-05-25 | 22.7 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.7.4) |
| 22.7.5 | 2026-05-27 | 22.7 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.7.5) |
| 23.0.0 | 2026-06-16 | Major: Node 22 floor, agentic migrations, sandboxing, .NET GA, TS loading, completion | [tag](https://github.com/nrwl/nx/releases/tag/23.0.0) |
| 22.7.6 | 2026-06-23 | 22.7 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.7.6) |
| 23.0.1 | 2026-06-23 | 23.0 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/23.0.1) |
| 22.7.7 | 2026-07-10 | 22.7 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/22.7.7) |
| 23.0.2 | 2026-07-10 | 23.0 maintenance fixes | [tag](https://github.com/nrwl/nx/releases/tag/23.0.2) |
| 23.1.0 | 2026-07-13 | Angular 22, performance reports, target defaults, TUI, migration/cache fixes | [tag](https://github.com/nrwl/nx/releases/tag/23.1.0) |

## Synthesis: Comprehensive Adoption Matrix

### Already adopted by the version upgrade

| Capability | Repository value | Action/state |
|---|---|---|
| Large-workspace project graph | Faster graph calculation as the monorepo grows | Automatic in Nx 23 |
| Lower daemon memory | Reduces persistent local resource use | Automatic in Nx 23 |
| Faster local cache replay | Makes repeated package builds and tests cheaper | Automatic in Nx 23 |
| Worktree-aware local cache | Better isolation across parallel Git worktrees | Automatic; managed sandboxes may still need explicit writable cache directories |
| Native TypeScript config loading | Less config-loader overhead and fewer loader dependencies | Automatic in Nx 23 |
| V8 compile cache | Faster CLI startup on repeated invocations | Automatic in Nx 23 |
| Task performance summary | Makes critical path/cache behavior visible after runs | Automatic in Nx 23.1; retain output in CI logs |
| Inferred frontend Vitest target | Removes the explicit executor scheduled for deletion in Nx 24 | Official conversion generator applied; `frontend:test` reverified |
| Target-owned React Router types | Makes docs typechecking reproducible from a cold checkout | Cached `docs:typegen` output now precedes `docs:typecheck`; red/green cold run verified |
| CI workspace synchronization gate | Detects generated TypeScript/reference drift before affected lint/test/build work | `nx sync:check` now runs immediately after CI dependency installation |
| Latest GitHub Actions | Keeps CI, release, and Pages workflows on current Node-based action runtimes | All 11 references updated from checkout/setup-node 4 and other older majors to the current official release lines |
| Nested release-tag configuration | Uses the supported release schema | Configuration migrated |
| React Router/Vitest/SWC/tooling migrations | Current compatible support line | Dependency migration applied |
| Node 22 minimum | Removes old Node runtime compatibility burden | Already satisfied by latest-LTS policy and Node 24 verification |
| Vite 8/Rolldown | One Rust-based production and development pipeline | Adopted at 8.1.5; all builds pass |
| TypeScript 6 compiler and API | One stable compiler package shared by CLI and JavaScript tooling | Pinned to latest 6.x release, 6.0.3 |
| Vite native TypeScript paths | Removes a redundant config-discovery plugin | `vite-tsconfig-paths` removed; `resolve.tsconfigPaths` enabled |
| React plugin 6/Oxc and React Compiler | Current fast React transform plus opt-in compiler transform | Adopted through `@rolldown/plugin-babel` |
| React Router 8 | Current ESM/React 19/Node 22 baseline | Server context migrated to `RouterContextProvider` |
| Zod 4 | Current validation core and new metadata/JSON Schema surfaces | Adopted at 4.4.3; call sites migrated |
| LangChain 1 | Current modular package layout | Text splitters moved to `@langchain/textsplitters` |
| AI SDK 7 | Current model/tool/agent runtime primitives | All SDK packages refreshed; existing behavior verified |
| Strict npm peer visibility | Stops install policy from hiding graph problems | `legacy-peer-deps=true` removed |
| Safe advisory remediation | Removes fixable transitive exposure without direct-package downgrades | Non-breaking audit fix applied; critical count is zero |

### Adopt now

| Priority | Capability/change | Why now | Effort | Acceptance check |
|---:|---|---|---:|---|
| P0 | Make test report directories target-owned | Fresh checkouts currently require manual `test-results/` creation | Small | Every test target passes after deleting ignored outputs |
| P0 | Make generated SDK a first-class frontend dependency | Frontend build/typecheck requires `.evals-sdk-it` generation plus workspace linking | Medium | Fresh checkout can run frontend build/typecheck with no manual sequence; generated drift cannot produce transient type failures |
| P1 | Replace or isolate advisory roots | Latest `xlsx`, VitePress, FastEmbed, Verdaccio, secure-exec, and node polyfills retain upstream advisories | Medium/Large | Reachability documented; fixed upstream versions or safer substitutes adopted; never downgrade through `npm audit fix --force` |
| P1 | Track latest-major peer metadata | SDK-IT, ESLint plugins, Babel consumers, and VitePress still declare earlier-major ranges | Medium | Upstream ranges accept the verified graph and full `npm ls --all` exits zero |
| P1 | Decide the `autoevals` package-manager contract | Latest 0.3.0 explicitly rejects npm/yarn and requires pnpm 10.27+ | Medium | Either migrate the repo to pnpm deliberately or replace/isolate `autoevals`; do not suppress the warning |
| P1 | Split the frontend entry chunk | Production build emits a 1.75 MB entry chunk (479.87 kB gzip) | Medium | Route/vendor boundaries reduce initial transfer and the Vite warning is resolved or intentionally budgeted |
| P1 | Make the Context abort test deterministic | Its 100 ms timing assumption failed only under heavy parallel verification, then passed focused and sequential runs | Small | Test coordinates on observable state rather than wall-clock scheduling |
| P1 | Use `nx show target` and target-source annotations in contributor diagnostics | Faster explanation of inferred versus explicit targets | Small | Troubleshooting docs include the commands |
| P2 | Use `nx list --json` for repository tooling | Stable machine-readable plugin/capability inventory | Small | Internal scripts stop scraping human CLI output |
| P2 | Record Nx performance summaries for slow CI runs | Current output already identifies critical paths and recoverable time | Small | CI logs preserve summary for representative workflows |
| P2 | Decide CI fail-fast policy with `NX_BAIL` | Can stop expensive dependent work after the first hard failure | Small | Explicit policy per workflow, especially where `continue-on-error` currently exists |
| P2 | Audit custom `dependsOn` strings and plugin helper APIs before Nx 24 | Nx 23 deprecates magic strings and legacy helper surfaces | Medium | No deprecated Nx API warnings in workspace tooling |
| P2 | Ignore all new Nx generated state | Prevent accidental commits of self-healing/polygraph/migration run data | Small | `.gitignore` covers `.nx/self-healing`, `.nx/polygraph`, and `.nx/migrate-runs` as applicable |
| P2 | Add a latest-direct-dependency CI check | The requested policy is latest stable, not merely semver-satisfied | Small | CI compares direct declarations with registry dist-tags and special-cases only verified registry anomalies |

### Evaluate when prerequisites exist

| Capability | Potential value | Current blocker / decision gate |
|---|---|---|
| Vite DevTools and browser-console forwarding | Better build graph and runtime diagnostics | Enable when the team defines local/CI logging expectations [21] |
| Vite 8.1 bundled dev mode and chunk import maps | Potentially faster development startup and finer chunk behavior | Experimental; benchmark the frontend before opting in [22] |
| Vite Lightning CSS pipeline | Faster CSS processing and minification | Compare Tailwind/output parity before changing production CSS behavior [22] |
| Vite WebAssembly ESM/SSR | Cleaner Wasm consumption for future local-model or parser work | No current Wasm consumer justifies enabling it [21][22] |
| TypeScript 7 native editor/LSP | Compiler-speed benefits during interactive development | Roll out when the selected editor extension supports the native preview/stable channel [23] |
| React Router route instrumentation | Route-level timing/observability metadata | Connect to the repository's telemetry only when a concrete dashboard/trace consumer exists [24] |
| React Router Web Streams entry | More web-standard server streaming | Optional in 8.2; compare with current Node response behavior before changing [24] |
| Zod metadata registries and JSON Schema | One source of truth for validation, docs, and tool schemas | Pilot on one API/tool contract before broad conversion [25] |
| Zod Mini | Smaller client validation bundles | Measure bundle savings against API ergonomics before adopting [25] |
| Zod pretty errors, i18n, file and template schemas | Better user errors and richer validation | Adopt at the specific UI/upload/config boundaries that need them [25] |
| LangChain `createAgent` and content blocks | Easier interop with LangChain providers and multimodal content | Use at integration boundaries only; DeepAgents' own agent runtime remains authoritative [26] |
| AI SDK 7 runtime/tool contexts and provider files/skills | Cleaner request-scoped dependencies and provider capabilities | Pilot in one agent path with existing integration tests [27] |
| AI SDK 7 approvals, workflow agents, sandboxing and timeouts | More durable long-running and human-gated execution | Compare with Zukhruf's existing durable semantics before composing or replacing anything [27] |
| AI SDK 7 telemetry/lifecycle statistics, MCP Apps/TUI, realtime/video | New observability and product surfaces | Adopt only with a named product consumer and data-retention policy [27] |
| ESLint 10 recommended rules and JSX reference tracking | Stronger current static analysis | Enable in a focused lint change after auditing findings and plugin peer support [28] |
| Nx Cloud remote caching | Cross-machine/CI cache reuse could materially reduce build time | Requires cost, trust, retention, and secret-handling decision |
| Task sandboxing | Detect undeclared inputs/outputs and improve hermeticity | Current official workflow is tied to Nx Cloud; pilot on deterministic package builds first [19] |
| Automatic flaky-task retries | Could stabilize known environmental flakes | Avoid masking real flakes; requires Nx Cloud and a retry policy |
| ReleaseGraph/project filters | Better selective release automation | Validate against the repository’s current all-package release process first [20] |
| `targetDefaults` spread/filtered defaults | Reduce duplication while retaining special cases | Adopt only when repeated target configuration warrants it |
| Dependency filesets with `^{projectRoot}` | More precise cache invalidation for selected dependency files | Benchmark against current named inputs before changing hashes |
| Shell completion | Better local CLI discovery | Individual developer preference; no repository change required |
| Fullscreen/mouse TUI | Better interactive local task navigation | TUI is currently disabled; reconsider only if contributors want it |
| `configure-ai-agents` | Generate Nx guidance for coding agents | Compare output against existing repository-specific `AGENTS.md`; do not overwrite stronger local rules |
| Agent-assisted migrations | May help explain future migrations | Keep generated prompts review-only; never accept source edits without normal tests and diff review |

### Not applicable or low value now

| Capability | Reason |
|---|---|
| pnpm catalogs today | Repository currently uses npm workspaces; reconsider only as part of the explicit `autoevals` package-manager decision |
| Maven/Gradle improvements | No JVM projects in the workspace |
| `@nx/dotnet` | No .NET projects in the workspace |
| Angular 21/22 support | No Angular application |
| Next 16 support | No Next.js application |
| Expo 54 support | No Expo application |
| Nuxt 4 support | No Nuxt application |
| Storybook 10 support | Storybook is not configured |
| Cypress 15 support | Cypress is not configured |
| Module Federation updates | No Module Federation topology |
| Nx Cloud artifact decryption | No Nx Cloud artifact workflow |

## Claims-Evidence Table

| Claim | Evidence | Confidence |
|---|---|---|
| 23.1.0 was the latest stable Nx version on the research date | npm/GitHub release state and 23.1 tag [17] | High |
| Nx packages should use one matching version | Official release/version policy [2] | High |
| Nx 23 requires Node 22 and adds the named major capabilities | Official Nx 23 article and tag [5][16] | High |
| Worktree caching and daemon/cache improvements arrived in 22.7 | Official 22.7 article and tag [4][15] | High |
| The frontend now uses inferred Vitest execution and no longer carries the Nx 24 executor-removal blocker | Official generator diff, target-source inspection, and passing `frontend:test` [5] | High |
| Every checked-in direct dependency except TypeScript is on its latest stable dist-tag; TypeScript is deliberately pinned to the latest 6.x release | Per-package registry queries, package manifests, lockfile, and final `npm outdated`; `autoevals` anomaly cross-checked against its real dist-tag | High |
| Vite 8 and TypeScript 6.0.3 are adopted; TypeScript 7 is deferred | Official release/migration guidance plus repository build, test, and typecheck verification [21][23] | High |
| Remaining peer errors are upstream range lag, not demonstrated runtime incompatibility | Strict `npm ls --all` compared with successful build/test/typecheck verification | High for this repository revision |
| The remaining 27 audit findings require upstream fixes or replacement decisions | Final npm audit; forced suggestions would downgrade current direct packages | High for installed graph; reachability still requires product analysis |
| Nx Cloud/task sandboxing could improve hermeticity | Official sandbox documentation [19] | Medium until piloted in this repo |
| ReleaseGraph/filtering could improve selective releases | Official Nx release documentation [20] | Medium until current release workflow is modeled |

## Counterevidence Register

| Initial proposition | Counterevidence | Resolution |
|---|---|---|
| Latest majors must wait until every peer range is updated | ESLint plugins, Babel consumers, and VitePress lag in peer metadata, but the repository's complete build/test/typecheck suite passes | Keep the selected versions, surface the peer warnings, and track upstream metadata instead of hiding it |
| TypeScript 7 should be adopted during this cutover | Its native compiler/API boundary adds integration complexity to Nx and SDK tooling | Keep one direct `typescript@6.0.3` dependency for both CLI and tooling, and revisit TypeScript 7 separately [23] |
| Frontend typecheck failure proves a toolchain regression | The generated SDK was stale; the normal generation step refreshed it and all 12 final typechecks pass | Make generation an explicit target dependency so clean and warm checkouts behave identically |
| Backend build failure proves an esbuild/Nx incompatibility | The installed esbuild binary runs and the target passes from `/private/tmp`; the worktree copy is delayed by managed macOS binary scanning | Treat as environment-only verification friction |
| `legacy-peer-deps` makes installs reliable | It allowed a missing direct Recharts peer and invalid upstream relationships to remain hidden | Removed; peer lag is now visible and documented |
| `npm audit fix --force` would make the latest graph safer | npm proposes downgrading FastEmbed, Verdaccio, and node-polyfills and cannot fix `xlsx`/VitePress | Keep latest packages; replace, isolate, or wait for fixed upstream releases after reachability review |
| All new Nx features should be enabled | Several features require Nx Cloud, different ecosystems, or tooling absent from this repository | Adopt only where the repository has a concrete consumer |

## Limitations

- The release ledger is exhaustive at the stable-version level, but patch rows summarize maintenance scope rather than reproducing every individual commit. Each row links to its official tag for commit-level details.
- GitHub and Nx documentation are authoritative for release content, but performance figures in Nx’s 22.7 article are vendor benchmarks, not measurements from this repository.
- Docker-backed PostgreSQL, MySQL, and SQL Server cases and credentialed BigQuery cases were unavailable in this managed environment. Their test suites reported skips rather than failures.
- One Context disk-full case was skipped because `hdiutil` could not create a test APFS image in the managed environment.
- The normal `npm install` lifecycle could not be observed end-to-end through `/usr/bin/env node` because the managed macOS environment suspends that launcher during Husky prepare. The same installed Husky entry point completes under the explicit Node 24 binary, and `npm install --ignore-scripts` completes normally.
- Dependency and peer conclusions describe the lockfile as of 2026-07-17. Peer ranges and advisory data change over time and should be rechecked continuously.
- `npm audit` counts are a triage signal, not a finding that every advisory is reachable in production.

## Recommendations

1. Merge the Nx 23.1.0 and dependency cutover together with its source migrations; the verified graph is Vite 8.1.5 plus the deliberate TypeScript 6.0.3 compatibility hold.
2. Make SDK generation/linking and test-report directory creation explicit Nx dependencies so a fresh checkout behaves like a warm checkout.
3. Decide whether `autoevals` justifies a deliberate pnpm migration. Until then, retain its visible engine warning instead of hiding it.
4. Track the ESLint plugin, Babel, and VitePress peer ranges upstream and require the green build/test/typecheck matrix during future refreshes.
5. Replace or isolate vulnerable `xlsx`, VitePress, FastEmbed/tar, Verdaccio, secure-exec, and node-polyfill paths according to production reachability; never accept npm's forced downgrades blindly.
6. Convert the frontend's 1.75 MB entry chunk into measured route/vendor boundaries, and make the Context abort test event-driven rather than scheduler-timing-dependent.
7. Add latest-direct-dependency drift detection and retain Nx 23.1 performance summaries in CI. Decide where `NX_BAIL=true` should replace wasteful continuation.
8. Pilot the Vite, TypeScript, React Router, Zod, LangChain, AI SDK, and Nx capabilities in the adoption matrix only where a named product/runtime consumer exists.
9. Pilot Nx Cloud/remote caching and task sandboxing only after documenting data handling, cost, cache retention, and failure policy.

## Bibliography

[1] Nx. “Changelog.” https://nx.dev/changelog — official chronological release record, accessed 2026-07-17.

[2] Nx. “Nx and Angular Version Compatibility / Releases.” https://nx.dev/docs/reference/releases — official version and release policy, accessed 2026-07-17.

[3] Nx. “Nx 22 Release.” https://nx.dev/blog/nx-22-release — official major-release overview, accessed 2026-07-17.

[4] Nx. “Nx 22.7 Release.” https://nx.dev/blog/nx-22-7-release — official worktree, daemon, and cache performance overview, accessed 2026-07-17.

[5] Nx. “Nx 23 Release.” https://nx.dev/blog/nx-23-release — official major-release overview, accessed 2026-07-17.

[6] Nx GitHub. “Nx 21.6.5.” https://github.com/nrwl/nx/releases/tag/21.6.5 — official patch tag, accessed 2026-07-17.

[7] Nx GitHub. “Nx 21.6.11.” https://github.com/nrwl/nx/releases/tag/21.6.11 — official long-lived 21.6 patch tag, accessed 2026-07-17.

[8] Nx GitHub. “Nx 22.0.0.” https://github.com/nrwl/nx/releases/tag/22.0.0 — official major tag, accessed 2026-07-17.

[9] Nx GitHub. “Nx 22.1.0.” https://github.com/nrwl/nx/releases/tag/22.1.0 — official minor tag, accessed 2026-07-17.

[10] Nx GitHub. “Nx 22.2.0.” https://github.com/nrwl/nx/releases/tag/22.2.0 — official minor tag, accessed 2026-07-17.

[11] Nx GitHub. “Nx 22.3.0.” https://github.com/nrwl/nx/releases/tag/22.3.0 — official minor tag, accessed 2026-07-17.

[12] Nx GitHub. “Nx 22.4.0.” https://github.com/nrwl/nx/releases/tag/22.4.0 — official minor tag, accessed 2026-07-17.

[13] Nx GitHub. “Nx 22.5.0.” https://github.com/nrwl/nx/releases/tag/22.5.0 — official minor tag, accessed 2026-07-17.

[14] Nx GitHub. “Nx 22.6.0.” https://github.com/nrwl/nx/releases/tag/22.6.0 — official minor tag, accessed 2026-07-17.

[15] Nx GitHub. “Nx 22.7.0.” https://github.com/nrwl/nx/releases/tag/22.7.0 — official minor tag, accessed 2026-07-17.

[16] Nx GitHub. “Nx 23.0.0.” https://github.com/nrwl/nx/releases/tag/23.0.0 — official major tag, accessed 2026-07-17.

[17] Nx GitHub. “Nx 23.1.0.” https://github.com/nrwl/nx/releases/tag/23.1.0 — official latest minor tag, accessed 2026-07-17.

[18] Nx. “Automate Updating Dependencies.” https://nx.dev/features/automate-updating-dependencies — official `nx migrate` workflow, accessed 2026-07-17.

[19] Nx. “Task Sandboxing.” https://nx.dev/docs/features/ci-features/sandboxing — official sandbox capability documentation, accessed 2026-07-17.

[20] Nx. “Manage Releases.” https://nx.dev/features/manage-releases — official `nx release` feature documentation, accessed 2026-07-17.

[21] Vite. “Announcing Vite 8.” https://vite.dev/blog/announcing-vite8 — official Rolldown, Oxc, TypeScript paths, DevTools, console-forwarding, and Wasm release overview, accessed 2026-07-17.

[22] Vite. “Announcing Vite 8.1.” https://vite.dev/blog/announcing-vite8-1 — official bundled-dev, chunk-import-map, Lightning CSS, and Wasm ESM update, accessed 2026-07-17.

[23] Microsoft TypeScript. “Announcing TypeScript 7.0.” https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ — official native compiler and side-by-side TypeScript 6 tooling API guidance, accessed 2026-07-17.

[24] React Router. “Changelog.” https://reactrouter.com/start/start/changelog — official React Router 8 requirements and 8.1/8.2 feature record, accessed 2026-07-17.

[25] Zod. “Zod 4.” https://zod.dev/v4 and https://zod.dev/v4/changelog — official Zod 4 capabilities and migration record, accessed 2026-07-17.

[26] LangChain. “LangChain v1.” https://docs.langchain.com/oss/javascript/releases/langchain-v1 — official JavaScript v1 release and package-boundary overview, accessed 2026-07-17.

[27] Vercel. “AI SDK 7.” https://vercel.com/blog/ai-sdk-7 — official AI SDK 7 capability overview, accessed 2026-07-17.

[28] ESLint. “Migrate to v10.x.” https://eslint.org/docs/latest/use/migrate-to-10.0.0 — official ESLint 10 breaking changes and rules-engine migration guide, accessed 2026-07-17.

[29] GitHub Actions. “actions/checkout v7.0.0.” https://github.com/actions/checkout/releases/tag/v7.0.0 — official release tag, accessed 2026-07-17.

[30] GitHub Actions. “actions/setup-node v7.0.0.” https://github.com/actions/setup-node/releases/tag/v7.0.0 — official release tag, accessed 2026-07-17.

[31] Nx GitHub. “nrwl/nx-set-shas v5.0.1.” https://github.com/nrwl/nx-set-shas/releases/tag/v5.0.1 — official release tag, accessed 2026-07-17.

[32] mikepenz GitHub. “action-junit-report v6.4.2.” https://github.com/mikepenz/action-junit-report/releases/tag/v6.4.2 — official release tag, accessed 2026-07-17.

[33] GitHub Actions. “actions/configure-pages v6.0.0.” https://github.com/actions/configure-pages/releases/tag/v6.0.0 — official release tag, accessed 2026-07-17.

[34] GitHub Actions. “actions/upload-pages-artifact v5.0.0.” https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0 — official release tag, accessed 2026-07-17.

[35] GitHub Actions. “actions/deploy-pages v5.0.0.” https://github.com/actions/deploy-pages/releases/tag/v5.0.0 — official release tag, accessed 2026-07-17.

## Methodology

### Source policy

Technical claims use primary sources only: official Nx, Vite, TypeScript, React Router, Zod, LangChain, Vercel AI SDK, and ESLint documentation; official GitHub release tags; installed package manifests; repository configuration; npm registry dist-tags; and live command output. The Nx changelog established the release interval, release tags verified stable versions and dates, and official major/minor announcements grouped material capabilities. Repository-specific adoption decisions were tested against actual packages, peers, targets, workflows, and build behavior rather than inferred from generic release marketing.

### Migration method

1. Inventory direct Nx versions, Node policy, package manager, registered plugins, target topology, and worktree state.
2. Confirm the latest stable Nx version from npm and official GitHub/Nx sources.
3. Run `nx migrate 23.1.0` and execute deterministic migrations.
4. Review every generated interactive/agent migration prompt against current source and configuration.
5. Query the current stable dist-tag for every direct external package and update all checked-in workspace declarations without version holds.
6. Implement required Vite 8, TypeScript 6, React Router 8, Zod 4, LangChain 1, React 19, and related source/config migrations.
7. Remove `legacy-peer-deps`, regenerate the lockfile, add missing direct peers, and distinguish verified runtime compatibility from lagging upstream peer metadata.
8. Apply only non-breaking audit fixes; reject forced actions that downgrade latest packages.
9. Run Nx report/sync, all builds, all test targets, and all typecheck targets using the repository's Nx targets.
10. Inventory every versioned GitHub Action and move all workflow references to their latest official major release tags.
11. Separate source failures, generated-artifact prerequisites, native-environment limitations, deprecation warnings, registry anomalies, and remaining upstream advisories.

### Research artifacts

The adjacent `sources.jsonl`, `evidence.jsonl`, `claims.jsonl`, and `run_manifest.json` files provide a machine-readable source/evidence ledger for this report.
