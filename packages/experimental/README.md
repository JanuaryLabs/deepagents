# @deepagents/experimental

A home for unstable, in-progress building blocks that are not yet part of the
stable `@deepagents/*` surface. APIs here may change without notice.

## `@deepagents/experimental/coding-agent-reminders`

`coding-agent-reminders` is an experimental event-aware reminder and guard
framework for coding agents. It provides Claude Code hook types, predicates,
context normalization, command I/O, and rule evaluation without prescribing a
reminder catalog. See
[`src/coding-agent-reminders/README.md`](./src/coding-agent-reminders/README.md)
for the public API and lifecycle mapping.

## `@deepagents/experimental/zukhruf`

Zukhruf is an internal DSL for **declaring** an agent, plus a **runtime** that
executes that declaration as a **durable background agent** — built on
`@deepagents/context` primitives (`agent()`, `ContextEngine`, `AgentSandbox`,
fragments, the stream subsystem).

```ts
import {
  AgentRuntime,
  PgBossTurnQueue,
  defineAgent,
  renderTurn,
} from '@deepagents/experimental/zukhruf';
```

The public experimental surface contains the pure declaration layer
(`defineAgent` / `defineInstructions` / `defineTool` / `defineSandbox`),
`AgentRuntime`, the domain values, and the store/queue ports and adapters.
Declarations have a types-only dependency on `@deepagents/context`.
`AgentRuntime` exposes enqueue, host mailbox delivery, observation, approval,
denial, worker lifecycle, and model-facing collaboration for declared
subagents. Its control plane, executor, status projector, mailbox coordinator,
and injected collaboration-tool implementations are internal wiring. See
[`src/zukhruf/DESIGN.md`](./src/zukhruf/DESIGN.md) for the decided semantics,
[`TODO.md`](./src/zukhruf/TODO.md) for the convergence plan, and
[`BUGS.md`](./src/zukhruf/BUGS.md) for known residue.

Zukhruf discovers immediate `skills/<name>/SKILL.md` children from each
configured sandbox once per conversation. It persists only the ordered catalog
(`name`, `description`, and model-visible `path`) in chat metadata so later turns
and process restarts reconstruct the same prompt fragment without rediscovery.
Skill bodies, scripts, references, and assets remain in the sandbox. Providers
may preinstall or mount them, or opt into the existing `uploadDirectory` support
when creating the sandbox.

Runnable end-to-end showcases live in
[`demo/zukhruf-simple`](../../demo/zukhruf-simple) (the smallest complete
deployable unit),
[`demo/zukhruf-durable-turns`](../../demo/zukhruf-durable-turns) (the durable
executor: enqueue, detach, resume, strict per-chat FIFO),
[`demo/zukhruf-mailbox`](../../demo/zukhruf-mailbox) (API-key-free host delivery,
durable FIFO mail, and payload-free wakes),
[`demo/zukhruf-research-bot`](../../demo/zukhruf-research-bot) (durable
planner and researcher chats with mailbox-delivered findings),
[`demo/zukhruf-group-chat`](../../demo/zukhruf-group-chat) (managed group-chat
orchestration over a shared transcript), and
[`demo/zukhruf-whatsapp`](../../demo/zukhruf-whatsapp) (manager-free group
notifications where specialists volunteer public replies).
`spawn_agent` can fork all parent turns, no parent turns, or a bounded number of
recent user-turn boundaries into a child chat through its `fork_turns` input.
