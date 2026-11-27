# Each agent is an Adapter from a located session to one trajectory

Status: ruled by Ezz on 2026-11-27 (deepagents #6107). Amended on 2026-11-27 while building: a subagent transcript is its own type, `ClaudeCodeSubagent`, not a `ClaudeCodeSession` with a field that means "not a subagent". `ClaudeCodeSubagent.fromTranscriptPath` takes a SubagentStop hook's `agent_transcript_path`, and `ClaudeCodeAdapter` implements `Adapter<ClaudeCodeSession | ClaudeCodeSubagent>`.

## Context

The leaders split finding sessions from reading them:

- franken: `detect` / `scan` on the `Connector` trait;
- letta: `listTrajectories` / `normalizeTranscript`;
- meticulous: `findTraceSessions` / `convert*Session`;
- the Claude Agent SDK: `listSessions` / `getSessionMessages`.

Each agent locates a session differently. Claude has one transcript plus a subagent folder. Codex has several rollout files of one thread, some of them zstd.

## Decision

- `Adapter<Session>` has `agent` (ATIF `agent.name`) and `read(session, options) → ReadResult`.
- Each agent has its own `Session` type, `ClaudeCodeSession` or `CodexThread`, so an adapter cannot be handed another agent's session.
- Stores are per agent too.
- No registry and no "detect every agent". A host composes the stores it needs.

## Consequences

- A Goose, Crush or VS Code adapter is a class of the host's or a later member of this package. No change to the port is needed.
- The package has no global list of agents to keep in sync.
