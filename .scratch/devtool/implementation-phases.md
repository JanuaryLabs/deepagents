# `@deepagents/devtool` implementation phases

## Objective

Establish `@deepagents/devtool` as a publishable, development-only Zukhruf
plugin before deciding which inspection or control capabilities it contains.
Deliver it as independently verifiable vertical slices.

## Completion record

All four establishment phases were implemented and verified on 2026-08-20:

- Phase 1: public `AgentRuntime` lifecycle integration, typecheck, test, and
  build pass.
- Phase 2: loopback validation, ephemeral port, health, startup conflict, and
  disposal behavior pass through the public integration test.
- Phase 3: the approved shell builds as private Vite assets, is served from the
  package, has a complete fetchable asset graph, and passes a headless Chrome
  smoke check.
- Phase 4: the dry-run and real tarballs contain only the public package
  artifacts; a temporary consumer proved development startup/disposal and a
  production build with no devtool module, listener, or UI chunk.

The capability checkpoint remains in force: no inspection or control surface
was added to `AgentPluginHost`.

## Decided shape

- The published module is a normal TypeScript Nx library.
- Its public interface is Node-only: `devtool()` returns an
  `AgentRuntimePlugin` registered through `AgentRuntimeOptions.plugins`.
- The consumer installs it as a `devDependency` and conditionally imports it
  while constructing the runtime in development.
- React is never part of the public interface.
- When a web shell is introduced, Vite builds it in application mode into
  static assets owned and served by the plugin.
- React, shadcn, Radix, Tailwind, and Vite remain build-time dependencies of
  this workspace package. They are bundled into the static UI and are not
  peer or runtime dependencies for consumers.
- The package binds to a loopback address by default. Remote access and its
  authentication contract require a separate approved slice.

## Source contracts

Re-check these files at the start of each phase because Zukhruf is
experimental and may change:

- `packages/experimental/src/zukhruf/runtime/agent-runtime.ts` — plugin host,
  initialization, work, and disposal lifecycle.
- `packages/experimental/src/zukhruf/plugins/schedules/index.ts` — existing
  stateful plugin and single-runtime ownership pattern.
- `packages/experimental/src/zukhruf/plugins/file-agents/index.ts` — smallest
  existing runtime plugin.
- `packages/agent/{package.json,project.json,tsconfig.lib.json,eslint.config.mjs}`
  — current public-package structure.
- `apps/evals-web-runner/frontend/vite.config.ts` — existing Vite application
  build.
- `apps/evals-web-runner/backend/src/routes/ui.route.ts` — existing static UI
  serving pattern.
- `TEST_PRIMITIVES.md` — test primitives to reuse before introducing any test
  utility.

## Phase 1 — Publishable TypeScript plugin package

Create `packages/devtool` using the current public-package conventions, with
the package identity `@deepagents/devtool`. Keep the implementation Node-only
and omit Vite, React, UI source, and UI dependencies.

The first public interface is deliberately small:

```ts
import { devtool } from '@deepagents/devtool';

const plugin = devtool();
const runtime = new AgentRuntime(root, {
  // existing runtime dependencies
  plugins: [plugin],
});
```

Tasks:

1. Add the package manifest, Nx project, TypeScript configs, ESLint config,
   `src/index.ts`, and one public-surface integration test.
2. Match the workspace's current version, repository metadata, public tag,
   exports, files, and release conventions at implementation time.
3. Import the Zukhruf plugin contract through the published
   `@deepagents/experimental/zukhruf` module specifier.
4. Declare `@deepagents/experimental` as the consumer-supplied peer and the
   package's development-time type/test dependency; the emitted JavaScript
   must not import it when the source import is type-only.
5. Make one plugin instance single-runtime-owned, matching the established
   schedules-plugin invariant.
6. Drive the plugin through `AgentRuntime`; do not call internal methods or
   expose test-only entry points.

Completion gate:

- A consumer can import `devtool()`, register it in `plugins`, initialize the
  runtime, start work, and dispose work without error.
- The test imports package module specifiers rather than relative source paths.
- `nx run @deepagents/devtool:typecheck` passes.
- `nx run @deepagents/devtool:test` passes and runs the build first.
- `nx run @deepagents/devtool:build` passes from a clean package output.
- The diff contains no React, Vite, Tailwind, shadcn, server, or runtime-host
  expansion.

## Phase 2 — Loopback server lifecycle

Make the plugin observably useful without introducing a UI. Reuse the repo's
Hono and Node-server pattern to start an HTTP server from the plugin's `work()`
lifecycle.

Tasks:

1. Add only the server dependencies directly imported by this package.
2. Accept the minimum stable options needed to select loopback host and port;
   support port `0` so tests avoid fixed-port races.
3. Expose the resolved local URL from the returned plugin after the listener
   starts.
4. Serve a health endpoint that returns the package/runtime readiness state.
5. Return an `AsyncDisposable` that stops accepting connections and closes the
   listener. Dispose partial startup if `work()` fails.

Completion gate:

- A public-surface integration test registers the plugin through
  `AgentRuntime`, calls `runtime.work()`, fetches the health endpoint, and gets
  a successful response.
- Disposing runtime work closes the listener; a later request cannot connect.
- Reusing one plugin instance with another runtime fails clearly.
- The typecheck, test, and build targets from Phase 1 remain green.

## Phase 3 — Bundled Vite shell

Add an internal React application only after the server lifecycle is green.
Before editing UI source, read `packages/experimental/src/zukhruf/DESIGN.md`
in full, create an ASCII wireframe for the shell, and obtain explicit approval.

The shell proves packaging and serving only. It does not introduce agent-tree,
turn-inspection, or control capabilities.

Tasks:

1. Place the private Vite application under `packages/devtool/ui`; do not add a
   React export from the package.
2. Build in Vite application mode so React and every UI dependency are bundled
   into browser assets.
3. Keep UI build dependencies out of `dependencies` and `peerDependencies`.
4. Add an explicit Nx UI build target. Write Vite output to a staging directory,
   then let the normal package build copy it into `dist/ui` so the esbuild clean
   step cannot erase it.
5. Make `nx run @deepagents/devtool:typecheck` cover both the Node plugin and
   private UI TypeScript projects.
6. Serve `dist/ui/index.html` and its referenced assets from the Phase 2 server.
7. Have the shell call the same-origin health endpoint and render the approved
   connected or unavailable state.

Completion gate:

- `nx run @deepagents/devtool:build` produces the Node entry, declarations,
  `dist/ui/index.html`, and all referenced browser assets.
- The built Node entry has no runtime import of React, React DOM, Radix,
  Tailwind, or Vite.
- The package manifest has no React or UI peer dependencies.
- The integration test starts the built plugin and fetches both the HTML shell
  and every asset referenced by it.
- A browser smoke check confirms the approved shell loads and reaches health.
- The package's typecheck, test, and build targets remain green.

## Phase 4 — Development-consumer proof

Prove the packed artifact works as developers will consume it, without adding
devtool product capabilities.

Expected consumer composition:

```ts
const plugins =
  process.env.NODE_ENV === 'development'
    ? [(await import('@deepagents/devtool')).devtool()]
    : [];

const runtime = new AgentRuntime(root, {
  // existing runtime dependencies
  plugins,
});
```

Tasks:

1. Run `npm pack --dry-run` and verify that the tarball contains the Node entry,
   declarations, and complete UI asset graph, but no source-only or test files.
2. Exercise the packed artifact from a temporary consumer using package module
   specifiers.
3. Verify the development branch starts and disposes the plugin.
4. Verify the production branch does not resolve or start the package.
5. Document only the installation, conditional import, local URL, and lifecycle
   needed to use this established shell.

Completion gate:

- The packed-artifact consumer test passes without importing React or CSS.
- The production branch runs with no devtool listener or UI chunk in its built
  output.
- The package is ready for the workspace release process.
- All changes remain unstaged unless staging is explicitly requested.

## Capability checkpoint

Stop after Phase 4. At that point the package, plugin lifecycle, local server,
static UI delivery, development-only loading, and published artifact are proven.

Choose the first devtool job separately and implement it as the next vertical
slice. That discussion will determine the smallest read model or control added
to `AgentPluginHost`; package establishment does not change that host interface.
