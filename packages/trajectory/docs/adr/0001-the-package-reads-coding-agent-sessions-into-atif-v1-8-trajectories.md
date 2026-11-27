# The package reads coding-agent sessions into ATIF v1.8 trajectories

Status: ruled by Ezz on 2026-11-27 (deepagents #6107).

## Context

About 39 places in the maintainer's repos and scratch scripts read Claude Code transcripts by hand. Seven of them are repo parsers: agent-plugin's ezzs-way `rules/transcript.ts`, `compile-guard`, housekeeping `lib/session.mjs`, the two update-docs evidence readers and `coding/mods/e2e.py`, plus this repo's `experimental/coding-agent-reminders`. They copy the same knowledge: what a typed prompt is, how a tool call pairs with its result, where a subagent's file is, and how a session continues after `/clear`. The research is in `~/.claude/plans/session-reader-research-2026-11-27.md`.

## Considered options

- **One official reader per agent** (Claude Agent SDK, Codex app-server). Rejected: two models to merge, and the app-server costs about 1.1 s to start.
- **`@letta-ai/trajectory`**: one TypeScript model for 15 agents. Rejected: a closed set of sources and a closed schema with no extra slot.
- **franken-agent-detection**: 35 connectors and an open trait. Rejected: Rust only, so it would need a bridge to Node.
- **ATIF as the port, with adapters that return it.** This option was selected.

## Decision

- The package returns Harbor's ATIF v1.8: steps, tool calls, observations, metrics, subagent trajectories and `extra` at every level.
- ATIF is read by Harbor, Inspect Scout and letta, and appears in NVIDIA NeMo Evaluator, Kaggle benchmarks, Microsoft SkillLens and Hugging Face safeagents. An adapter written once is therefore readable by all of them.

## Consequences

- Consumers stop parsing. They filter steps and read `extra`.
- ATIF is one project's RFC (status Active, one maintainer), not a standards body's. A break in a later version is ported on purpose.
