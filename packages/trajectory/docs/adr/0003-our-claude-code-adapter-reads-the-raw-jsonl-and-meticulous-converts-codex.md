# Our Claude Code adapter reads the raw JSONL, and meticulous converts Codex

Status: ruled by Ezz on 2026-11-27 (deepagents #6107). Amended on 2026-11-27 while building: `CodexThread` carries its `subagents` (every thread under it, flat), which `CodexStore.threads()` groups from each rollout's `session_meta` with meticulous's own rule (`parentIdOf`, `findRootId`, `compareRollouts`); `CodexAdapter` hands them to `convertCodexSession`, which links each to the call that spawned it (`collab_agent_spawn_end`). meticulous's v1.7 steps map onto this package's union field by field, and an image whose media type ATIF does not name becomes a text part that names it.

## Context

`@alwaysmeticulous/agent-traces` 3.2.0 (ISC, no dependencies, pure functions on text) converts Claude Code and Codex to ATIF. A read of its source and a probe on a real session found that its Claude converter builds steps only from `user` and `assistant` lines:

- **G1:** it drops `queued_command` attachments. The probe lost a typed mid-turn prompt.
- **G2:** it drops `system` rows: `stop_hook_summary`, `turn_duration`, `compact_boundary`.
- **G3:** it drops every other attachment, including `hook_additional_context`.
- **G4:** it ignores `toolUseResult`.
- **G5:** it does not follow `/clear` `derived-from` chains.
- **G6:** it ignores `parentUuid` and `isSidechain`.
- **G7:** it has no origin model beyond `extra.origin_kind`.

It has no extension points. The hooks and miners need G1 to G5.

Its Codex converter reads `session_meta`, `turn_context`, `response_item`, `event_msg`, `token_usage_record`, `compacted` and `inter_agent_communication`. It tells typed prompts from injected context, and it links subagent threads.

## Considered options

- **meticulous for Claude, plus a second pass that re-reads the dropped lines and merges them.** Rejected: two parsers of one file, merged by position.
- **Our own adapter for both agents.** Rejected for now: meticulous's Codex mapping is good, and Codex is history only (agent-plugin dropped it on 2026-11-27).
- **Our own Claude adapter at full fidelity, with meticulous's `convertCodexSession` wrapped for Codex.** This option was selected.

## Decision

- `ClaudeCodeAdapter` reads the JSONL itself, as ADR 0004 maps it.
- `CodexAdapter` decodes `.jsonl.zst` with `node:zlib` `zstdDecompressSync`, calls `convertCodexSession`, and sets `schema_version` to `ATIF-v1.8`. v1.8 only adds audio content parts, so a v1.7 document is valid v1.8.
- meticulous is pinned to an exact version, because its repo is a mirror of a private one with thin converter tests.

## Consequences

- The Claude format knowledge lives in one file of this package.
- A meticulous release is read and probed before its pin moves.
