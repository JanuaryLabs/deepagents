# Nx Post-Build Hooks: Options for Running Scripts After Build

**Date:** 2026-04-04
**Context:** Evaluating approaches to run the OpenAPI generator script automatically after esbuild builds complete, including in watch mode.

## Current Setup

The `@sdk-it` OpenAPI generator (`apps/evals-web-runner/backend/openapi.ts`) runs as a separate Nx target via `nx:run-commands`, configured as a `dependsOn` prerequisite for build. This means it runs **before** build, not after.

```jsonc
// apps/evals-web-runner/backend/project.json
"openapi": {
  "executor": "nx:run-commands",
  "command": "node apps/evals-web-runner/backend/openapi.ts"
},
"build": {
  "dependsOn": ["^build", "openapi"]  // openapi runs BEFORE build
}
```

## Key Finding: Nx Has No Native `postTargets`

Nx does **not** have a built-in `postTargets` or "run after build" feature as of v21.x.

- Requested in [nrwl/nx#20799](https://github.com/nrwl/nx/issues/20799) (33 thumbs-up, Dec 2023)
- Converted to [Discussion #27048](https://github.com/nrwl/nx/discussions/27048) (59+ reactions)
- No implementation timeline from the Nx team

`dependsOn` only works for **prerequisites** (run X before Y), not post-hooks.

## Options Evaluated

### Option 1: esbuild `onEnd` Plugin via `esbuildConfig`

`@nx/esbuild` supports custom esbuild plugins through the `esbuildConfig` option (not `esbuildOptions` -- they are **mutually exclusive**).

```jsonc
// project.json
"build": {
  "executor": "@nx/esbuild:esbuild",
  "options": {
    "esbuildConfig": "esbuild.config.ts"
  }
}
```

```ts
// esbuild.config.ts
import type { BuildOptions } from 'esbuild';

export default {
  plugins: [{
    name: 'openapi-generator',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        // run openapi generation
      });
    },
  }],
} satisfies Partial<BuildOptions>;
```

| Pros | Cons |
|------|------|
| Native watch mode support (fires on every rebuild) | Must migrate from `esbuildOptions` to `esbuildConfig` (mutually exclusive) |
| Single config file, low complexity | Loses Nx-level caching of the openapi step |
| Tightest integration with esbuild lifecycle | `onEnd` cannot modify output files |

**Migration note:** The workspace-level `esbuildOptions` in `nx.json` (loaders for `.txt`, `.sql`, `.md`) must move into the `esbuildConfig` file. Per-project overrides (e.g., backend's `external` and `banner`) also need their own config files.

### Option 2: Custom Nx Executor Wrapping `@nx/esbuild`

Create a custom executor that delegates to `@nx/esbuild` and runs post-build logic after each yield.

```ts
// tools/executors/esbuild-with-hooks/executor.ts
import { esbuildExecutor } from '@nx/esbuild/src/executors/esbuild/esbuild.impl';

export default async function* (options, context) {
  for await (const result of esbuildExecutor(options, context)) {
    if (result.success) {
      await runOpenApiGenerator();
    }
    yield result;
  }
}
```

| Pros | Cons |
|------|------|
| Full Nx integration (caching, graph, watch) | Requires creating an executor package under `tools/` |
| Works with existing `esbuildOptions` (no migration) | More boilerplate to maintain |
| Can run arbitrary post-build logic | Couples to `@nx/esbuild` internals |

### Option 3: Composite Target with `dependsOn`

Create a wrapper target that depends on both build and a post-build step.

```jsonc
"postbuild": {
  "dependsOn": ["build"],
  "executor": "nx:run-commands",
  "command": "node openapi.ts"
},
"ci": {
  "dependsOn": ["build", "postbuild"]
}
```

| Pros | Cons |
|------|------|
| Zero code, pure config | No watch mode integration |
| Full Nx caching | Must invoke the wrapper target, not `build` directly |
| Clear dependency graph | Confusing target naming |

### Option 4: `nx watch` CLI

```sh
nx watch --projects=backend -- nx run backend:openapi
```

| Pros | Cons |
|------|------|
| Zero config changes | CLI-level, not declarative |
| Works today | Separate process to manage |
| | File-change based, not build-completion based |

### Option 5: Third-Party `@nx-boat-tools/common`

Provides a `chain-execute` executor with `preTargets` and `postTargets` support.

| Pros | Cons |
|------|------|
| Declarative `postTargets` | External dependency |
| Drop-in replacement | Unknown maintenance status |

## esbuild Plugin Hooks Reference

| Hook | When | Use Case |
|------|------|----------|
| `onStart` | Before build begins | Validation, cache clearing |
| `onResolve` | Import path resolution | Redirecting imports, virtual modules |
| `onLoad` | File loading | Custom loaders, transforms |
| `onEnd` | After build completes | Post-processing, codegen, notifications |
| `onDispose` | Context cleanup | Resource cleanup |

Lifecycle: `onStart` -> `onResolve`/`onLoad` (per module) -> `onEnd`

## Recommendation

**For tightest dev experience:** Option 1 (esbuild `onEnd` plugin) -- simplest, native watch support, one file.

**For most Nx-native approach:** Option 2 (custom executor) -- full Nx integration, works with existing config, but more setup.

**For zero-change quick win:** Option 3 (composite target) -- works today, no code, but no watch mode.

## References

- [@nx/esbuild executor docs](https://nx.dev/docs/technologies/build-tools/esbuild/executors)
- [esbuild Plugin API](https://esbuild.github.io/plugins/)
- [Nx postTargets request - Issue #20799](https://github.com/nrwl/nx/issues/20799)
- [Nx postTargets discussion #27048](https://github.com/nrwl/nx/discussions/27048)
- [@nx/esbuild esbuildConfig PR #16092](https://github.com/nrwl/nx/pull/16092)
