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

`zukhruf` is an internal DSL for **declaring** an agent, plus a **runtime** that
executes that declaration as a **durable background agent** — built on
`@deepagents/context` primitives (`agent()`, `ContextEngine`, `AgentSandbox`,
fragments, the stream subsystem).

```ts
import {
  AgentRuntime,
  PgBossTurnQueue,
  defineAgent,
} from '@deepagents/experimental/zukhruf';
```

The customer surface contains the pure declaration layer (`defineAgent` /
`defineInstructions` / `defineTool` / `defineSandbox`), `AgentRuntime`, the domain values, and the
store/queue ports and adapters. Declarations have a types-only dependency on `@deepagents/context`.
`AgentRuntime` exposes enqueue, host mailbox delivery, observation, approval, denial, and worker
lifecycle. Its control plane, executor, status projector, mailbox coordinator, and injected
collaboration-tool implementations are internal wiring. See
[`src/zukhruf/DESIGN.md`](./src/zukhruf/DESIGN.md) for the decided semantics,
[`TODO.md`](./src/zukhruf/TODO.md) for the convergence plan, and
[`BUGS.md`](./src/zukhruf/BUGS.md) for known residue.

Runnable end-to-end showcases live in
[`demo/zukhruf-durable-turns`](../../demo/zukhruf-durable-turns) (the durable
executor: enqueue, detach, resume, strict per-chat FIFO) and
[`demo/zukhruf-mailbox`](../../demo/zukhruf-mailbox) (API-key-free host delivery,
durable FIFO mail, and payload-free wakes) and
[`demo/zukhruf-research-bot`](../../demo/zukhruf-research-bot) (an agentic
research bot: plan → web-search subagent → streamed report).
