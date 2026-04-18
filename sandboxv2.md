# Sandbox v2: Skills Owned by the Sandbox

## Context

Today `skills()` fragment declares skill paths and the user **separately** mounts/uploads skill files to the sandbox (via `mounts`, `uploadDirectory`, etc.). The two configs can drift — if the declared `sandbox:` path doesn't actually have the files, the LLM hits silent `file not found` at runtime.

Decision: **sandbox becomes the single source of truth for skills**. The user passes `skills: [{ host, sandbox }]` to the sandbox factory; the factory uploads files and discovers metadata once. `skills()` fragment stops scanning disk and simply reads `sandbox.skills`.

No live-sync requirement — snapshot-at-startup semantics across all backends.

## Agreed Design

### Type: `AgentSandbox`

```ts
// packages/context/src/lib/sandbox/types.ts (new file)
import type { BashToolkit } from 'bash-tool';
import type { SkillPathMapping } from '../skills/types.ts';

export interface SkillUploadInput {
  host: string;
  sandbox: string;
}

export interface AgentSandbox extends BashToolkit {
  skills: SkillPathMapping[]; // always defined, [] if none
}
```

### Factories accept `skills`

**`createBashTool` wrapper** (new, in `@deepagents/context`):

```ts
const sandbox = await createBashTool({
  skills: [{ host: './skills', sandbox: '/workspace/skills' }],
  // plus all CreateBashToolOptions from external bash-tool
});
```

**`createContainerTool`** (updated):

```ts
const sandbox = await createContainerTool({
  image: 'alpine:latest',
  packages: ['curl'],
  skills: [{ host: './skills', sandbox: '/workspace/skills' }],
});
```

Both return `AgentSandbox` with `.skills` populated from on-disk discovery.

### `skills()` fragment — simplified

```ts
// Before
context.set(skills({ paths: [{ host, sandbox }], include, exclude }));

// After
context.set(skills(sandbox));
```

New signature:

```ts
export function skills(sandbox: AgentSandbox): ContextFragment;
```

No disk scanning, no path rewriting, no include/exclude (filtering moves to factory via selective `skills` arrays).

### `CreateAgent.sandbox` type change

```ts
// packages/context/src/lib/agent.ts
import type { AgentSandbox } from './sandbox/types.ts';

export interface CreateAgent<CIn, COut = CIn> {
  name: string;
  sandbox: AgentSandbox; // was BashToolkit
  // ...
}
```

Every factory returns `AgentSandbox` so no call-site breakage for sandbox shape.

## Backend Behavior

All backends use the universal `Sandbox.writeFiles()` interface — no backend-specific branching in the skills logic.

| Backend             | Factory                                        | File upload mechanism                             |
| ------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Docker              | `createContainerTool`                          | `toolkit.sandbox.writeFiles()` after container starts |
| just-bash (default) | `createBashTool()`                             | `toolkit.sandbox.writeFiles()` into virtual FS    |
| E2B / Vercel        | `createBashTool({ sandbox: cloudSandbox })`    | `toolkit.sandbox.writeFiles()` via cloud API      |
| Agent OS (WASM)     | `createBashTool({ sandbox: wasmSandbox })`     | `toolkit.sandbox.writeFiles()` via WASM FS        |

## Implementation Steps

### 1. Create `packages/context/src/lib/sandbox/types.ts`

Export `AgentSandbox` and `SkillUploadInput`. Re-export `SkillPathMapping` from `../skills/types.ts` for convenience.

### 2. Create `packages/context/src/lib/sandbox/bash-tool.ts` (wrapper)

```ts
import {
  createBashTool as externalCreateBashTool,
  type CreateBashToolOptions,
} from 'bash-tool';

import { discoverSkillsInDirectory } from '../skills/loader.ts';
import type { SkillPathMapping } from '../skills/types.ts';
import type { AgentSandbox, SkillUploadInput } from './types.ts';
import { walkDirectory } from './walk.ts'; // new helper

export async function createBashTool(
  options: CreateBashToolOptions & { skills?: SkillUploadInput[] } = {},
): Promise<AgentSandbox> {
  const { skills: skillInputs = [], ...rest } = options;

  const toolkit = await externalCreateBashTool(rest);

  const discovered: SkillPathMapping[] = [];
  const filesToUpload: { path: string; content: string | Buffer }[] = [];

  for (const { host, sandbox: sandboxBase } of skillInputs) {
    for (const skill of discoverSkillsInDirectory(host)) {
      const rel = skill.skillMdPath.slice(host.length);
      discovered.push({
        name: skill.name,
        description: skill.description,
        host: skill.skillMdPath,
        sandbox: sandboxBase + rel,
      });
    }
    for (const file of walkDirectory(host)) {
      filesToUpload.push({
        path: sandboxBase + file.path.slice(host.length),
        content: file.content,
      });
    }
  }

  if (filesToUpload.length > 0) {
    await toolkit.sandbox.writeFiles(filesToUpload);
  }

  return { ...toolkit, skills: discovered };
}
```

### 3. Add `walkDirectory` helper at `packages/context/src/lib/sandbox/walk.ts`

Simple recursive FS walk returning `{ path: string; content: string | Buffer }[]`. Use `node:fs/promises` `readdir` with `withFileTypes`, read file contents, normalize path separators.

### 4. Factor shared upload logic into `packages/context/src/lib/sandbox/upload-skills.ts`

```ts
import type { Sandbox } from 'bash-tool';

import { discoverSkillsInDirectory } from '../skills/loader.ts';
import type { SkillPathMapping } from '../skills/types.ts';
import type { SkillUploadInput } from './types.ts';
import { walkDirectory } from './walk.ts';

export async function uploadSkills(
  sandbox: Sandbox,
  inputs: SkillUploadInput[],
): Promise<SkillPathMapping[]> {
  const discovered: SkillPathMapping[] = [];
  const filesToUpload: { path: string; content: string | Buffer }[] = [];

  for (const { host, sandbox: sandboxBase } of inputs) {
    for (const skill of discoverSkillsInDirectory(host)) {
      const rel = skill.skillMdPath.slice(host.length);
      discovered.push({
        name: skill.name,
        description: skill.description,
        host: skill.skillMdPath,
        sandbox: sandboxBase + rel,
      });
    }
    for (const file of walkDirectory(host)) {
      filesToUpload.push({
        path: sandboxBase + file.path.slice(host.length),
        content: file.content,
      });
    }
  }

  if (filesToUpload.length > 0) {
    await sandbox.writeFiles(filesToUpload);
  }
  return discovered;
}
```

Both `createBashTool` (wrapper) and `createContainerTool` call `uploadSkills` — no logic duplication.

### 5. Update `packages/context/src/lib/sandbox/container-tool.ts`

- Add `skills?: SkillUploadInput[]` to all three option unions (Runtime/Dockerfile/Compose) and `BaseContainerToolOptions`.
- Change `ContainerToolResult` from `Omit<BashToolkit, 'sandbox'> & { sandbox: DockerSandbox }` to `Omit<AgentSandbox, 'sandbox'> & { sandbox: DockerSandbox }`.
- After creating the toolkit, call `uploadSkills(sandbox, skillInputs)` and attach result to the returned object.

### 6. Simplify `packages/context/src/lib/skills/fragments.ts`

```ts
import dedent from 'dedent';

import type { ContextFragment } from '../fragments.ts';
import type { AgentSandbox } from '../sandbox/types.ts';

export function skills(sandbox: AgentSandbox): ContextFragment {
  const mounts = sandbox.skills ?? [];

  if (mounts.length === 0) {
    return { name: 'available_skills', data: [], metadata: { mounts: [] } };
  }

  const skillFragments: ContextFragment[] = mounts.map((s) => ({
    name: 'skill',
    data: { name: s.name, path: s.sandbox, description: s.description },
  }));

  return {
    name: 'available_skills',
    data: [
      { name: 'instructions', data: SKILLS_INSTRUCTIONS } as ContextFragment,
      ...skillFragments,
    ],
    metadata: { mounts },
  };
}

const SKILLS_INSTRUCTIONS = dedent`...`; // keep existing text
```

Delete `discoverSkillsInDirectory` call, path mapping, include/exclude filtering.

### 7. Clean up `packages/context/src/lib/skills/types.ts`

- Remove `SkillsFragmentOptions` (no longer used).
- Keep `SkillPathMapping`, `SkillMetadata`, `ParsedSkillMd`.

### 8. Update `packages/context/src/lib/agent.ts`

- Change `sandbox: BashToolkit` → `sandbox: AgentSandbox` in `CreateAgent<CIn, COut>`.
- Import `AgentSandbox` from `./sandbox/types.ts`.
- No runtime logic changes (tool merging, `asTool()` sub-agent plumbing, guardrail context — all unchanged).

### 9. Update exports

- `packages/context/src/lib/sandbox/index.ts`: add `export * from './types.ts';` and `export * from './bash-tool.ts';`.
- `packages/context/src/index.ts`: unchanged (re-exports `./lib/sandbox/index.ts`).

### 10. Update `packages/context/src/lib/demo.ts`

```ts
import { createContainerTool } from './sandbox/container-tool.ts';
import { skills } from './skills/fragments.ts';

const sandbox = await createContainerTool({
  image: 'alpine:latest',
  packages: ['curl', 'jq', 'nodejs', 'npm'],
  resources: { cpus: 0.5, memory: '512m' },
  skills: [
    {
      host: join(process.cwd(), 'agent-sandbox-test/skills'),
      sandbox: '/workspace/skills',
    },
  ],
});

context.set(soul(), skills(sandbox));
```

Remove the standalone `mounts: [{ hostPath: 'agent-sandbox-test', containerPath: '/workspace' }]` — skill uploads handle `/workspace/skills`; any other user-specified mount is still supported separately via `mounts`.

### 11. Update `packages/context/src/usage.ts`

Three `agent()` call sites:

- `greetingSandbox = await createBashTool()` → switch import to `@deepagents/context` wrapper. No skills needed. Works as-is.
- `skillSandbox = await createBashTool({ sandbox: new Bash(...), uploadDirectory: {...} })` → migrate to `skills: [{ host: 'packages/context/src/skills', sandbox: '/skills/skills' }]` on the wrapper. Drop `uploadDirectory` for skills.
- `dockerSandbox = await createContainerTool({...})` → add `skills: [...]` on the container factory.

Update every `skills(...)` call from the old object API to `skills(sandbox)`.

### 12. Update tests

All test files currently do `const sandbox = await createBashTool()` (external `bash-tool`). Change the import to the wrapper from `@deepagents/context`. No `skills` needed — `sandbox.skills` defaults to `[]`.

Files:

- `packages/context/src/lib/agent.subagent.test.ts`
- `packages/context/src/lib/agent.repair.test.ts`
- `packages/context/src/lib/chat.test.ts`
- `packages/text2sql/test/chat.integration.test.ts`
- `packages/text2sql/src/evals/formatting/formatting.eval.ts`
- `packages/text2sql/src/evals/helpers/conversation-simulator.ts`

### 13. Update docs

Files to update examples in:

- `apps/docs/app/docs/context/sandbox.mdx` — Quick Start
- `apps/docs/app/docs/context/container-tool.mdx` — Basic usage + Return value table + add `skills` prop doc
- `apps/docs/app/docs/context/agent.mdx` — Sandbox Options table (note `skills` support), main creating-agent example
- `apps/docs/app/docs/context/chat-function.mdx` — Examples
- `apps/docs/app/docs/context/guardrails.mdx` — Example

Call out in docs that `skills()` now takes the sandbox directly.

## API Summary

**Before:**

```ts
const sandbox = await createContainerTool({
  mounts: [{ hostPath: './skills', containerPath: '/workspace/skills' }],
});
context.set(
  skills({ paths: [{ host: './skills', sandbox: '/workspace/skills' }] }),
);
```

**After:**

```ts
const sandbox = await createContainerTool({
  skills: [{ host: './skills', sandbox: '/workspace/skills' }],
});
context.set(skills(sandbox));
```

## Edge Cases

1. **Empty skills** — `skills: []` or omitted → `sandbox.skills = []` → `skills(sandbox)` returns empty fragment.
2. **Multiple skill paths** — processed sequentially, all files uploaded. Later duplicates overwrite earlier ones (both in upload and in `skills[]`).
3. **Skill referenced files (assets, scripts, references/)** — uploaded as part of the directory walk.
4. **Very large skill trees** — upload cost proportional to file count. No chunking; users with huge trees should filter by path partition.
5. **Tests without skills** — `sandbox.skills = []` is the safe default; existing tests just update the import.

## Files to Modify

| Path                                                        | Change                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/context/src/lib/sandbox/types.ts`                 | NEW — define `AgentSandbox`, `SkillUploadInput`                 |
| `packages/context/src/lib/sandbox/walk.ts`                  | NEW — directory walker helper                                   |
| `packages/context/src/lib/sandbox/upload-skills.ts`         | NEW — shared discover + upload helper                           |
| `packages/context/src/lib/sandbox/bash-tool.ts`             | NEW — wrapper around external `createBashTool`                  |
| `packages/context/src/lib/sandbox/container-tool.ts`        | Add `skills`, return `AgentSandbox`, call `uploadSkills`        |
| `packages/context/src/lib/sandbox/index.ts`                 | Export new files                                                |
| `packages/context/src/lib/skills/fragments.ts`              | Simplify to `skills(sandbox)`                                   |
| `packages/context/src/lib/skills/types.ts`                  | Remove `SkillsFragmentOptions`                                  |
| `packages/context/src/lib/agent.ts`                         | `sandbox: AgentSandbox`                                         |
| `packages/context/src/lib/demo.ts`                          | Use new `skills` prop + `skills(sandbox)`                       |
| `packages/context/src/usage.ts`                             | Migrate three agent setups                                      |
| 3 test files in `packages/context/src/lib/*`                | Import wrapper                                                  |
| 3 files in `packages/text2sql/`                             | Import wrapper                                                  |
| 5 docs `.mdx` files                                         | Update examples                                                 |

## Verification

1. `nx run-many -t typecheck` — all packages type-check.
2. `nx run-many -t build` — all packages build.
3. `node --test packages/context/src/lib/agent.subagent.test.ts` — 33 tests pass.
4. `node --test packages/context/src/lib/agent.repair.test.ts` — 1 test passes.
5. `node --test packages/context/src/lib/chat.test.ts` — 29 tests pass.
6. `node --test packages/text2sql/test/chat.integration.test.ts` — passes.
7. Runtime smoke test:

   ```ts
   const sandbox = await createBashTool({
     skills: [
       {
         host: './packages/context/src/skills',
         sandbox: '/workspace/skills',
       },
     ],
   });
   console.assert(sandbox.skills.length > 0);
   const content = await sandbox.sandbox.readFile(sandbox.skills[0].sandbox);
   console.assert(content.includes('---'));
   ```

8. Demo: `node packages/context/src/lib/demo.ts` — agent can `readFile` skill paths listed in system prompt.

## Non-Goals

- Live sync of skill files (snapshot only, re-run agent to pick up edits).
- Changing `discoverSkillsInDirectory` behavior (still scans frontmatter the same way).
- Modifying the external `bash-tool` package.
- Adding skill filtering (`include`/`exclude`) — pruned; users control via what they pass to `skills: []`.
