# Agent v2: Sandbox as First-Class Mandatory Option

## Decision: Sandbox is mandatory for every `agent()` construction

The `@deepagents/context` agent (`packages/context/src/lib/agent.ts`) must require a sandbox. Without a sandbox, an agent is useless.

`structuredOutput()` is a separate function and does NOT require a sandbox.

## Agreed Design

### Field: `sandbox: BashToolkit`

- **Type**: `BashToolkit` from `bash-tool` package
- **Field name**: `sandbox`
- **Required**: Yes, mandatory on `CreateAgent`
- **Lifecycle**: External -- sandbox is created outside, passed in. Agent does not create or dispose it.
- **Sub-agents**: `asTool()` passes the same `sandbox` to sub-agents (shared, not forked)
- **Tool registration**: Auto-register -- agent merges `sandbox.tools` (bash, readFile, writeFile) into its toolset
- **Merge order**: `{ ...sandbox.tools, ...userTools }` -- user-provided tools override sandbox tools

### BashToolkit shape (from bash-tool)

```ts
import { type BashToolkit, type Sandbox } from 'bash-tool';

// BashToolkit is:
interface BashToolkit {
  bash: ReturnType<typeof createBashExecuteTool>;
  tools: {
    bash: ReturnType<typeof createBashExecuteTool>;
    readFile: ReturnType<typeof createReadFileTool>;
    writeFile: ReturnType<typeof createWriteFileTool>;
  };
  sandbox: Sandbox;              // programmatic access (executeCommand, readFile, writeFiles)
}
```

> **Type note:** `createContainerTool()` returns `ContainerToolResult` which is
> `Omit<BashToolkit, 'sandbox'> & { sandbox: DockerSandbox }`. `DockerSandbox`
> extends `Sandbox`, so it's structurally compatible. Verify assignability or
> use a broader type like `{ tools: ToolSet; sandbox: Sandbox }` if needed.

### Usage

```ts
// Docker
const sandbox = await createContainerTool({ image: 'alpine', packages: ['curl'] });
const ai = agent({ name: 'assistant', model, context, sandbox });

// E2B (via adapter implementing Sandbox interface)
const e2bSandbox: Sandbox = { executeCommand: ..., readFile: ..., writeFiles: ... };
const sandbox = await createBashTool({ sandbox: e2bSandbox });
const ai = agent({ name: 'assistant', model, context, sandbox });

// just-bash (default, no Docker needed)
const sandbox = await createBashTool();
const ai = agent({ name: 'assistant', model, context, sandbox });
```

### Implementation changes

1. **`CreateAgent` interface** -- add `sandbox: BashToolkit` as required field (import from `bash-tool`)
2. **Agent constructor** -- store sandbox reference, stays sync (no async init needed since BashToolkit is pre-resolved)
3. **`generate()` and `#createRawStream()`** -- merge `this.sandbox.tools` with `this.tools` when building toolset
4. **`asTool()`** -- pass `this.sandbox` to sub-agents when creating the inner `agent()`
5. **`clone()`** -- sandbox included via `this.#options` spread
6. **`asAdvisor()`** -- no changes needed (calls `generateText()` directly, does not create a new agent)
7. **`demo.ts`** -- simplify: remove manual bash tool wiring, pass sandbox directly
8. **Tests** -- all `agent()` calls need sandbox field (mock or just-bash)
9. **`chat.ts`** -- no changes needed (uses `ChatAgentLike` interface, receives agent instance)

### Files to modify

- `packages/context/src/lib/agent.ts` -- core changes
- `packages/context/src/lib/demo.ts` -- update usage
- `packages/context/src/lib/agent.subagent.test.ts` -- add sandbox to all agent() calls

---

## Research: OpenAI Managed Containers (NOT supported yet, future consideration)

### What they are

OpenAI offers server-side code execution through the Responses API:

1. **Code Interpreter** -- runs Python in OpenAI-hosted sandbox
2. **Shell tool (containerAuto)** -- runs arbitrary shell commands in OpenAI-hosted container

### How they work in AI SDK

They are **provider-defined tools**, not provider options:

```ts
import { openai } from '@ai-sdk/openai';

// Code Interpreter
tools: {
  code_interpreter: openai.tools.codeInterpreter({
    container: { fileIds: ['file-123'] }
  })
}

// Shell (server-side)
tools: {
  shell: openai.tools.shell({
    environment: {
      type: 'containerAuto',
      memoryLimit: '4g',
      fileIds: ['file-abc123'],
      networkPolicy: { type: 'allowlist', allowedDomains: ['example.com'] },
      skills: [{ type: 'skill_reference', skill_id: 'skill_abc123' }]
    }
  })
}

// Shell (local execution -- client handles commands)
tools: {
  shell: openai.tools.shell({
    execute: async ({ action }) => {
      return { output: [{ stdout: '...', stderr: '', outcome: { type: 'exit', exitCode: 0 } }] };
    }
  })
}
```

### Why NOT supported yet

OpenAI managed containers (containerAuto) are fundamentally limited compared to client-side sandboxes:

| Capability | Client-side (Docker/E2B) | OpenAI Managed |
|---|---|---|
| LLM tools (bash/shell) | Yes | Yes |
| Developer programmatic commands | Yes | No |
| Developer file read/write | Yes | Only via Files API |
| Command hooks (before/after) | Yes | No |
| Workspace setup | Mounts, writeFiles | Upload fileIds |

With managed containers you CANNOT:
- Execute custom commands programmatically
- Read/write files programmatically
- Define command hooks or filters
- Set up workspace via mounts

The only interaction is: upload files beforehand (via Files API), let the model run code, download output files afterward (via container file citations).

### Future unification path

If we want to support managed containers later, the common ground is `{ tools: ToolSet }` -- both client-side and managed sandboxes produce AI SDK tools. A tiered interface could work:

```ts
// Full sandbox (client-side)
interface FullSandbox {
  tools: ToolSet;
  sandbox: Sandbox;  // programmatic access
}

// Tool-only sandbox (server-managed)
interface ManagedSandbox {
  tools: ToolSet;
}

type AgentSandbox = FullSandbox | ManagedSandbox;
```

### OpenAI response shapes

**Code Interpreter output:**
```json
{
  "type": "code_interpreter_call",
  "container_id": "cntr_...",
  "code": "import math\nprint(math.factorial(10))",
  "outputs": [
    { "type": "logs", "logs": "3628800\n" },
    { "type": "image", "url": "https://..." }
  ]
}
```

**Shell tool output:**
```json
{
  "output": [
    { "stdout": "...", "stderr": "...", "outcome": { "type": "exit", "exit_code": 0 } }
  ]
}
```

**File artifacts:** Generated files produce `container_file_citation` annotations with `container_id`, `file_id`, `filename`. Download via: `GET /containers/{container_id}/files/{file_id}/content`.

### Three execution modes for shell tool

1. **containerAuto** -- OpenAI provisions container, server-side execution, no execute callback
2. **containerReference** -- reuse existing container by ID, server-side execution
3. **local** -- model proposes commands, client executes via `execute` callback (this is essentially the client-side pattern)

### E2B, Daytona, and other remote sandboxes

These fit the client-side model. They run in the cloud but your client SDK drives them via API calls. They can implement the `Sandbox` interface from bash-tool:

```ts
const e2bSandbox: Sandbox = {
  executeCommand: (cmd) => e2b.commands.run(cmd),
  readFile: (path) => e2b.files.read(path),
  writeFiles: (files) => Promise.all(files.map(f => e2b.files.write(f.path, f.content))),
};

const sandbox = await createBashTool({ sandbox: e2bSandbox });
```

### Relevant packages

| Package | Role |
|---|---|
| `bash-tool` (^1.3.16) | Provides `createBashTool()`, `Sandbox` interface, `BashToolkit` type |
| `just-bash` (^2.14.1) | Pure-JS virtual bash interpreter, default sandbox backend |
| `@vercel/sandbox` | Vercel cloud sandbox (optional peer dep of bash-tool) |
| `@ai-sdk/openai` | OpenAI provider with `openai.tools.shell()` and `openai.tools.codeInterpreter()` |
| `@rivet-dev/agent-os-core` | WASM sandbox (optional, experimental) |
