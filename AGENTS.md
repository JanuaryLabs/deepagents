### General rules

- Always ask more questions using AskUserQuestionTool until you have enough context to give an accurate & confident answer.

- **Reproduce first.** For any bug fix — even with a pre-diagnosed root cause — reproduce the failure live (a throwaway scratchpad script against the real CLI/API/library) before writing the red test or the fix. Reproduction confirms the diagnosis, yields real fixture payloads for tests, and surfaces adjacent breaks the diagnosis missed.

- **Cite a package call site before proposing new capability.** A gap that only a demo, eval, or test exercises is not a gap. Name the `packages/` call site (file:line) that needs the capability, or drop the proposal — never justify it with a deployment scenario nobody has wired up.

- **Own only what the AI SDK lacks.** [docs/aisdk-parity.md](./docs/aisdk-parity.md) gives each concept the repo owns a verdict against the AI SDK and the `vercel` / `vercel-labs` packages. Read its row before building or keeping framework code around model calls, tools, streams or steps. `node .claude/skills/aisdk-parity/scripts/delta.ts` lists what upstream shipped since the ledger's check, and the `aisdk-parity` skill turns that into verdicts and backlog items.

- **No backward compatibility.** Delete old or unused API outright, public exports of published packages included: no aliases, deprecations, migration paths or "nothing breaks" options, and no question to the owner about breaking npm users. Consumers move to the new form. This overrides a generic skill rule that treats public exports as not removable.

- **Force the deployment into the design.** Design for several processes on any number of hosts, with ownership held in the shared store. Never shape a design around today's host (one Mac mini, one VM): no "one process is enough for now" and no host-local lock as an option.

## Testing

- Focus on **integration tests** that test entire flows, not unit tests for individual functions.
- **No test-only side doors to internal classes.** Never add package `imports` aliases, extra build entry points, or `internal.ts` re-exports so tests can construct something the public barrel deliberately hides. If a test can't reach behavior through the public surface, rewrite the test to drive the public API (e.g. `AgentRuntime.deliver`/`work`), not the internals — test as a user would use it.
- Claims about pg-boss delivery or retry run on the real queue (`PgBossWakeScheduler` on PGlite), never on `RecordingWakeScheduler`: pg-boss moves a failed job's `start_after` on every retry, and the fake redelivers with the original `runAt`, which hid a retry defect until #5135 step 9 (#5695).
- Before adding test utilities, read [TEST_PRIMITIVES.md](./TEST_PRIMITIVES.md). Prefer its native Node.js APIs; reserve `@zukhruf/testing` for domain-free primitives, not shared fixtures or product-specific harnesses.

### Running tests

```sh
node --test --no-warnings --test-timeout=60000 path/to/package/test/file.test.ts
```

- The `@zukhruf/nx/test` plugin in `nx.json` infers `test` targets from `*.test.*`
  files outside Vitest projects. The default per-test timeout is 240 seconds;
  `nx.json` enables module mocks and builds before tests. Pass
  `--args="--test-timeout=<ms> path/to/file.test.ts"` to override the timeout and
  test selection. Paths are relative to the project root. Compaction and
  devtool-history override the timeout to 10 seconds.
- **Always pass `--test-timeout=<ms>` to direct `node --test` runs.** Prefer Nx for
  dependency-aware builds. Database classes share servers without runner setup;
  servers persist until explicit cleanup. See [TEST_PRIMITIVES.md](./TEST_PRIMITIVES.md).
- `nx run <project>:typecheck` runs only `tsc --build`: no ESLint and no Prettier. Before committing, run
  `npx eslint <files>` and `npx prettier --check <files>` on what you changed, test files included. The
  commit hook checks formatting and the pre-push gate runs each affected project's `lint`, `build` and
  `typecheck` targets on the pushed commit. Lint refused a type assertion in a test that typecheck had
  passed, and only typecheck sees a test file's type errors. The `lint` target is `eslint . --fix`, so it
  rewrites files.
- Run Nx build, test, and typecheck invocations sequentially in a shared checkout.
  Typecheck can rebuild dependencies and delete output directories that another
  test is importing. Use one `nx run-many` task graph or isolated worktrees when
  parallel verification is needed.

### Test import rules

- **Always use package module specifiers** in test files, not relative source paths:

  ```typescript
  // ✅ CORRECT
  import { tables, Sqlite } from '@deepagents/text2sql/sqlite';

  // ❌ WRONG - causes type mismatches
  import { tables } from './index.ts';
  ```

- **Why**: TypeScript treats private class members (`#field`) as unique per class declaration. Mixing imports from built packages and source files creates two incompatible types.

## Demos

- **A demo showcases its feature unconditionally.** No `--no-<feature>` opt-out flags, no
  `start:no-<feature>` script aliases, no parallel "plain" entry points. The capability-absence
  path is proven by the package's integration test (e.g. `schedules-http.integration.test.ts`
  composes `http(runtime)` without `schedulesHttp`), never by a second way to run the demo.

## Package overview

### @deepagents/agent (`packages/agent`)

A framework for building multi-agent AI systems with TypeScript. Create agents that use tools, coordinate through handoffs, and work together to solve complex tasks.

**Key Features:**

- **Agent Composition** - Build modular agents with specific roles and capabilities
- **Tool Integration** - Compatible with Vercel AI SDK tools
- **Handoffs** - Agents can delegate to specialized agents automatically
- **Structured Output** - Type-safe responses with Zod schemas
- **Streaming** - Real-time streaming responses
- **Context Sharing** - Type-safe state passed between agents

**Main Exports:** `agent`, `execute`, `swarm`, `instructions`, streaming utilities

### @deepagents/context (`packages/context`)

A domain-agnostic context management system for formatting context fragments into different prompt styles.

**Key Features:**

- **Multi-format Rendering** - XML, Markdown, TOML renderers for different LLM prompt styles
- **Context Store** - Persistent storage with SQLite and in-memory adapters
- **Skills Module** - Anthropic-style progressive disclosure with skills fragment
- **Token Estimation** - Estimate token usage across different models
- **Graph Visualization** - Visualize context graphs with branching and checkpoints

### @deepagents/text2sql (`packages/text2sql`)

AI-powered natural language to SQL. Ask questions in plain English, get executable queries.

**Key Features:**

- **Natural Language to SQL** - Convert questions to validated, executable queries
- **Multi-Database Support** - PostgreSQL, SQLite, and SQL Server adapters
- **Schema-Aware** - Automatic introspection of tables, relationships, indexes, and constraints
- **Teachables** - Inject domain knowledge via terms, hints, guardrails, examples, and more
- **Conversational** - Multi-turn conversations with history and user memory
- **Explainable** - Convert SQL back to plain English explanations
- **Safe by Default** - Read-only queries, validation, and configurable guardrails

**Teachable Types:** `term`, `hint`, `guardrail`, `example`, `explain`, `clarification`, `workflow`, `quirk`, `styleGuide`, `analogy`

### React chat UI (`packages/react`)

`@deepagents/react-input` is the headless chat composer (the `Composer` parts in `./browser`). `@deepagents/react-genai` gives them the chat kit's look (`ChatComposer`).

- A chat-composer part that consumer repos copy (the `@genui/*` packages of text2sql and blackboard, such as dictation) moves here, not to zukhruf: headless in react-input, the look in react-genai.
- Composer behavior follows the ChatGPT/Codex desktop app. Read its installed Electron bundle with the `baoyu-electron-extract` skill (with `--skip-format`), not docs or memory.

---

### Building packages

To build a package, use the following command:

```sh
nx run <package-name>:build
```

For example, to build the `agent` package, run:

```sh
nx run @deepagents/agent:build
```

### Running TypeScript files

The workspace's Node.js version runs TypeScript files directly without a separate build:

```sh
node path/to/file.ts
```

Include the file extension in relative imports:

```ts
import { someFunction } from './some-file.ts';
```

Node.js requires these extensions to resolve modules.

### Running evals

Pass an eval file relative to `packages/text2sql/src/evals`:

```bash
nx run @deepagents/text2sql:eval sql-create-context/sql-create-context.eval.ts
```
