# Zukhruf HTTP transport plugin plan

> Status: completed on 2026-08-28. Each phase was verified before the next phase began.
>
> Goal: make HTTP an optional Zukhruf transport plugin in source organization as well as in
> dependency direction, while preserving the public `@deepagents/experimental/zukhruf/http`
> entry point and the definition-bound projection model.

## Contract

This plan uses **plugin** in two explicit senses:

- A **runtime plugin** is an `AgentPluginDefinition` installed through an agent declaration and
  materialized by `AgentRuntime`.
- A **transport plugin** is an optional host-invoked package entry point such as HTTP or a future
  gRPC transport. It consumes the public runtime API; it is not installed into `AgentRuntime`.

The target dependency direction is:

```text
host
├── AgentRuntime(root-with-runtime-plugins)
└── HTTP transport plugin
    ├── built-in HTTP projection of runtime operations
    └── explicit HTTP projections of installed runtime plugins

Zukhruf core ── does not import or discover HTTP
```

### Locked decisions

- HTTP source belongs at `src/zukhruf/plugins/http/`.
- Its public import remains `@deepagents/experimental/zukhruf/http`; the public package path does
  not expose the physical `plugins/` directory.
- A future gRPC peer belongs at `src/zukhruf/plugins/grpc/` and may export as
  `@deepagents/experimental/zukhruf/grpc`.
- The root `@deepagents/experimental/zukhruf` entry point exports no HTTP types, routes, middleware,
  serializers, Hono values, or transport registry.
- `AgentRuntime` works without importing or constructing a transport plugin.
- Runtime plugins expose typed transport-neutral instances.
  `projectHttp(definition, project)` resolves the exact installed instance through
  `runtime.plugin(definition)` and adapts it to HTTP.
- `HttpProjection`, `HttpContribution`, `publicRoutes`, `authenticatedRoutes`, route validation,
  authentication boundaries, discovery, and SSE remain HTTP-plugin concepts.
- Hosts compose projections explicitly with `http(runtime, ...projections)`. Core does not scan
  runtime plugins for routes or infer protocol semantics from their methods.
- There is no augmentation layer, generic core projection registry, compatibility re-export from
  the old physical source path, or speculative gRPC implementation.
- The host chooses the Hono mount path. Discovery derives capability URLs from that mount.

Because HTTP remains a subpath of the existing `@deepagents/experimental` npm package, Hono remains
an installed package dependency. Transport neutrality here means that Zukhruf core source and
runtime behavior do not import or require HTTP. Dependency-install isolation would require a
separate npm package and is outside this plan.

## Baseline before implementation

The dirty working tree already contained an in-progress transport extraction:

- HTTP code currently lives at `src/zukhruf/http/` and is exported through
  `@deepagents/experimental/zukhruf/http`.
- Zukhruf core no longer imports Hono or owns plugin routes.
- HTTP projections bind directly to installed plugin definitions; no augmentation registry remains.
- `@deepagents/devtool-traces/http` projects the typed `fileTelemetry()` instance into authenticated
  trace routes.
- The demos and DevTool host mount `http(runtime, tracesHttp(traceTelemetry))`
  on their host-owned Hono app.

Verification recorded before this plan:

- experimental, DevTool traces, and DevTool typechecks passed;
- focused HTTP and runtime-plugin tests passed 26/26;
- DevTool traces passed 2/2 and DevTool host passed 3/3;
- scoped changed-file lint and both demo lint targets passed;
- the full experimental suite retained the already tracked pg-boss FIFO and retained-turn failures;
- DevTool traces package lint retained the already tracked `ai` dependency-classification failure.

Preserve the current staged and unstaged state. Each phase below changes only its declared scope and
leaves changes unstaged unless the user explicitly authorizes staging.

## Phase 0 — freeze the baseline _(Completed)_

### Work

- Record the current staged and unstaged paths without changing the index.
- Inventory every source, build entry point, package export, test, documentation link, and consumer
  that refers to `src/zukhruf/http` or `@deepagents/experimental/zukhruf/http`.
- Re-run the focused HTTP/plugin checks to distinguish this relocation from the known pg-boss and
  dependency-lint failures.
- Add characterization coverage only if one of the locked decisions is not observable through an
  existing public API test.

### Exit criteria

- The complete relocation surface is listed before a source path moves.
- Existing failures are identified by their current diagnostics and are not folded into this work.
- No production file has changed.

## Phase 1 — relocate the HTTP transport plugin _(Completed)_

### Work

- Move `index.ts`, `parse.ts`, `validator.ts`, and the HTTP integration test from
  `src/zukhruf/http/` to `src/zukhruf/plugins/http/`.
- Update their internal relative imports to the core runtime and mailbox types.
- Point the experimental build entry at `src/zukhruf/plugins/http/index.ts`.
- Point the existing `./zukhruf/http` package export at
  `dist/zukhruf/plugins/http/index.js` and its declaration file.
- Remove the empty sibling `src/zukhruf/http/` path. Do not leave a forwarding barrel.

### Behavioral proof

- Tests continue importing only `@deepagents/experimental/zukhruf/http`, never the physical source
  path.
- Building the package emits the relocated JavaScript and declaration entry points.
- A packed consumer resolves `@deepagents/experimental/zukhruf/http` successfully.

### Exit criteria

- All HTTP implementation and tests live under `plugins/http/`.
- The public import path and runtime behavior are unchanged.
- No compatibility file remains at the old physical path.

## Phase 2 — pin the transport boundary _(Completed)_

### Work

- Confirm the root Zukhruf barrel exposes only transport-neutral runtime and domain APIs.
- Confirm runtime source has no Hono import, HTTP contribution field, transport discovery object,
  augmentation token, or projection registry.
- Keep the HTTP plugin dependent on the narrow `HttpRuntime` view of public runtime operations.
- Keep `projectHttp()` definition-bound and fail fast when its definition is not installed in the
  supplied runtime.
- Keep route omission explicit: an unpassed projection contributes neither discovery nor routes.
- Prove public routes mount before the HTTP authentication boundary and authenticated routes after
  it.

### Behavioral proof

- A runtime definition can be constructed and exercised without importing the HTTP entry point.
- An installed definition projects its typed instance; an uninstalled definition fails at HTTP
  composition.
- The same runtime may be mounted at a host-selected path and discovery reports that path.
- Duplicate capability names and relative contributed paths fail inside the HTTP plugin.

### Exit criteria

- Core has no knowledge of transports.
- Every HTTP-specific contract is owned by `plugins/http/`.
- No second mechanism exists beside typed plugin instances and transport projections.

## Phase 3 — rebase projections, consumers, and documentation _(Completed)_

### Work

- Keep `fileTelemetry()` transport-neutral and keep `tracesHttp(definition)` in the traces package's
  `/http` entry point.
- Verify both demos and the DevTool host use only the unchanged public HTTP import and explicit
  projection composition.
- Update physical source links and architectural wording in Zukhruf and DevTool documentation.
- Update the packed-plugin consumer probe to import the public HTTP and trace-HTTP entry points and
  construct `http(runtime, tracesHttp(traceDefinition))`.
- Search the workspace for the retired physical path and for augmentation terminology introduced by
  this transport work.

### Exit criteria

- External consumers are insensitive to the physical source relocation.
- Documentation consistently calls HTTP a transport plugin and distinguishes it from runtime
  plugins.
- The packed artifact proves both public transport entry points exist and compose.

## Phase 4 — final verification and handoff _(Completed)_

### Verification

```sh
nx run @deepagents/experimental:typecheck
node --test --no-warnings packages/experimental/src/zukhruf/plugins/http/http.integration.test.ts packages/experimental/src/zukhruf/runtime/agent-runtime-plugin.integration.test.ts
nx run @deepagents/devtool-traces:typecheck
nx run @deepagents/devtool-traces:test
nx run @deepagents/devtool:typecheck
nx run @deepagents/devtool:test
nx run @deepagents/demo-zukhruf-simple:lint
nx run @deepagents/demo-zukhruf-research-bot:lint
node tools/src/verify-definition-owned-plugins.ts
git diff --check
```

Also run `nx run @deepagents/experimental:test` and compare any failures with the Phase 0 baseline.
Run scoped lint on every changed TypeScript file. Report the existing package-lint blocker separately
unless its diagnostic changes because of this work.

### Exit criteria

- Every focused transport, projection, trace, and host check is green.
- The full experimental suite introduces no failure beyond its recorded baseline.
- The packed public import probe is green.
- `rg` finds no live reference to `src/zukhruf/http` and no augmentation API or terminology from the
  discarded design.
- The final handoff reports changed paths, verification evidence, preserved unrelated work, and the
  exact known external blockers.
- Nothing is staged or committed without explicit authorization.

## Implementation result

- The HTTP transport plugin and its integration test live only under
  `src/zukhruf/plugins/http/`; no forwarding source entry remains.
- `@deepagents/experimental/zukhruf/http` maps directly to the relocated build output.
- The root barrel test proves HTTP runtime values remain absent from transport-neutral Zukhruf.
- The validator uses Hono's public string-valued header map directly; the redundant header-copy
  fallback was removed.
- The existing packed-consumer probe imports and composes the public HTTP and trace-HTTP entry
  points.
- Experimental, DevTool traces, and DevTool typechecks passed. Focused HTTP/runtime-plugin tests
  passed 26/26, the root-barrel suite passed 5/5, trace tests passed 2/2, DevTool host tests passed
  3/3, changed-file lint passed, and both demo lint targets passed.
- The full experimental comparison passed 282 tests and retained four out-of-scope failures plus
  one expected todo: three manifestations of the tracked pg-boss FIFO defect, the tracked retained
  queued-turn timeout, and an approval-restart timeout captured as backlog `#1314`.

## Out of scope

- Implementing gRPC.
- Automatically discovering transport projections from runtime plugins.
- A generic transport, augmentation, or route registry in Zukhruf core.
- Renaming the public `/zukhruf/http` entry point or changing its route protocol.
- Splitting HTTP into a separate npm package.
- Fixing the pg-boss FIFO/retention defects or unrelated package dependency-lint findings.
