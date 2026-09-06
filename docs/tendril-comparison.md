# Tendril vs. the Zukhruf Self-Extending Agent Tree

Compared against Tendril `main` at [v0.1.6 / `e671a41`](https://github.com/serverless-dna/tendril/commit/e671a4143d28de68289efd81580002041bb4cb6a) (2026-04-27) and the live [`demo/zukhruf-self-extending-agent-tree`](../demo/zukhruf-self-extending-agent-tree/README.md).

## Bottom line

Both systems persist an extension on the filesystem, discover it later by name, and create it when missing. The extension and the authority model are different:

- **Tendril extends one agent with executable tools.** The same Strands agent lists a structured registry, writes a TypeScript capability when needed, and executes it in Deno during the same agent loop.
- **Our demo extends an agent tree with reusable instructions.** Root delegates authorship to a fixed Skill Authority, waits for atomic publication of a `SKILL.md`, then starts a fresh General Task child that reads and applies it. Their separate agent contexts and instructions keep orchestration, authorship, and task execution distinct.

Tendril is therefore closest to our **missing-extension lifecycle**, not to our **multi-agent architecture** or our skill format.

## What Tendril actually implements

Tendril is a local desktop application: a Tauri/React host talks over ACP-style JSON-RPC/NDJSON to a standalone Node.js SEA sidecar, which runs one Strands `Agent` ([architecture](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/README.md#architecture), [agent construction](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/agent.ts#L86-L102), [stream loop](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/index.ts#L41-L113)). **Inference from the current product tree:** because that is the only agent declaration and no subagent or handoff runtime is present, Tendril is not a multi-agent system with specialized author/executor roles.

The current runtime exposes exactly three bootstrap tools: `listCapabilities`, `registerCapability`, and `execute`. Every tool-requiring action is prompted to list first; a miss leads to register then execute, while a hit leads directly to execute ([tool APIs](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/loop/tools.ts#L23-L109), [prompt contract](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/loop/prompt.ts#L4-L49)). `execute` accepts a registered name, loads its code internally, and cannot accept inline code ([v0.1.6 change](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/CHANGELOG.md#L7-L19)).

A capability is executable TypeScript plus selection metadata (`name`, description, triggers, suppression, path, provenance, and version). Tendril stores the catalog at `{workspace}/tools/index.json` and implementations at `{workspace}/tools/<name>.ts`; listing returns all compact metadata and lets the model choose ([registry](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/loop/registry.ts#L15-L93), [data model](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/types.ts#L1-L17)). Generated code runs in a Deno subprocess with workspace-scoped read/write, no prompt or process permission, a timeout and output cap, and either configured-domain or unrestricted network access ([sandbox](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/loop/sandbox.ts#L9-L105)).

Some Tendril documentation still says four bootstrap tools or mentions removed `searchCapabilities` / `loadTool`. Those passages are stale: current source and the v0.1.6 changelog establish the three-tool runtime. **Inference from repository-wide source search:** the `.agents/skills` and `.claude/skills` directories are contributor workflows, not product capabilities; no shipped runtime code loads them.

## Comparison

The table describes verified current implementation behavior; absence claims are repository-wide source-search inferences.

| Dimension | Tendril | Our Zukhruf demo |
|---|---|---|
| Control topology | One long-lived Strands agent performs selection, authorship, and execution ([source](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/agent.ts#L86-L102)). | Root orchestrator plus fixed Skill Authority and General Task sibling declarations ([source](../demo/zukhruf-self-extending-agent-tree/agent.ts#L19-L89)). |
| Extension unit | Executable TypeScript tool plus structured invocation metadata. | Procedural knowledge in `skills/<name>/SKILL.md`; the fresh worker still uses its ordinary sandbox tools ([source](../demo/zukhruf-self-extending-agent-tree/agent.ts#L28-L54)). |
| Catalog | Required central `tools/index.json` plus sibling `<name>.ts` files. | Directory structure is the catalog; there is deliberately no manifest or invocation API ([source](../demo/zukhruf-self-extending-agent-tree/README.md#L40-L44)). |
| Discovery | `listCapabilities()` returns the entire compact index on every action; the same model selects using descriptions, triggers, and suppression rules ([source](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/docs/agent-capability-spec.md#L136-L152)). | Root scans `skills/*/SKILL.md` at the start of each request, delegates explicit skill names, and the fresh General Task child reads those files on its first turn ([source](../demo/zukhruf-self-extending-agent-tree/agent.ts#L69-L86)). |
| Missing extension | The same agent calls `registerCapability`, then `execute`, in the same loop. | Root spawns Skill Authority, waits for publication confirmation, then spawns a fresh General Task child ([source](../demo/zukhruf-self-extending-agent-tree/agent.ts#L74-L84)). |
| Author/executor separation | No role separation. An API boundary does prevent bypassing registration by passing inline code to `execute`. | Separate agent contexts and instructions assign authorship to Skill Authority and execution to General Task. The shared sandbox does not enforce those role boundaries. |
| Publication integrity | Registration writes the index and then the TypeScript file sequentially; current code does not validate by compiling/executing before publication ([source](https://github.com/serverless-dna/tendril/blob/e671a4143d28de68289efd81580002041bb4cb6a/tendril-agent/src/loop/registry.ts#L65-L87)). | Skill Authority is instructed to write a hidden temporary directory, validate it, then rename atomically; the integration flow verifies publication before fresh-child discovery ([authoring contract](../demo/zukhruf-self-extending-agent-tree/agent.ts#L25-L35), [integration test](../demo/zukhruf-self-extending-agent-tree/agent.integration.test.ts#L106-L183)). |
| Filesystem authority | Each generated capability gets read/write over the whole selected workspace. There is no container or role-specific mount layer. | Each role has one named Microsandbox microVM; all three mount the same read-write workspace and skill catalog volumes ([source](../demo/zukhruf-self-extending-agent-tree/sandbox.ts)). |
| Persistence and reuse | Local, per-workspace tool registry survives later turns and launches. Reuse executes saved code by registered name. | A separately supplied shared skill catalog survives children and requests. Reuse injects saved instructions into a newly spawned worker by explicit name. |
| Product boundary | Packaged desktop agent sandbox with UI, provider configuration, ACP transport, and bundled Deno. | Focused runnable Zukhruf architecture demo using OpenAI `gpt-5.6-terra`, Microsandbox, and a queued multi-agent runtime ([source](../demo/zukhruf-self-extending-agent-tree/README.md#L47-L60)). |

## Architectural interpretation (inference)

Tendril optimizes for **tool-surface compression and autonomous executable capability growth**: the model always sees three stable meta-tools while the local implementation registry expands. Our demo optimizes for **role-specialized orchestration**: one role decides, another publishes reusable knowledge, and a fresh third role executes it in a shared sandbox.

These patterns are complementary rather than interchangeable. A `SKILL.md` can describe a workflow that uses many tools and judgment steps; a Tendril capability is the executable tool itself. Adopting Tendril's registry wholesale would remove our manifest-free discovery and collapse the author/executor boundary. Adopting only its name-based execution constraint could make sense later if our skills begin publishing executable capabilities, but the current demo does not need it.
