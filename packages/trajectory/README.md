# @deepagents/trajectory

> **Status:** Claude Code and Codex read today (#6107); other agents come as
> adapters. Each decision is in [docs/adr](./docs/adr).

Read a coding agent's stored sessions (Claude Code transcripts, Codex rollouts)
as [ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md)
v1.8 trajectories: one ordered list of user, agent and system steps per session,
with tool calls, their results, metrics and the subagents nested inside.

Each agent is an `Adapter`. This package ships one for Claude Code and one for
Codex. An agent it does not cover gets an adapter of your own that returns the
same `Trajectory`, so every consumer reads every agent the same way.

The package only reads. It owns no store, index or schedule, and it has no
policy. Rules such as "the housekeeping is due" belong to the host; this package
gives the host the steps to decide from.

## Read the transcript a hook was given

```ts
import {
  ClaudeCodeAdapter,
  ClaudeCodeSession,
  ClaudeCodeSubagent,
} from '@deepagents/trajectory';

// SubagentStop reads the subagent's own transcript, never the parent's.
const session = input.agent_transcript_path
  ? ClaudeCodeSubagent.fromTranscriptPath(input.agent_transcript_path)
  : ClaudeCodeSession.fromTranscriptPath(input.transcript_path);
const { trajectory } = await new ClaudeCodeAdapter().read(session, {
  subagents: false,
});

const written = trajectory.steps
  .flatMap((step) => (step.source === 'agent' ? (step.tool_calls ?? []) : []))
  .filter((call) =>
    ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(call.function_name),
  )
  .map((call) => call.arguments.file_path ?? call.arguments.notebook_path);
```

## Find what the user typed

```ts
const typed = trajectory.steps.filter(
  (step) =>
    step.source === 'user' && step.extra?.claude_code?.origin === 'human',
);
```

A prompt typed while the agent works (a `queued_command` attachment) is a user
step too. Task notifications, peer messages and hand-backs are user steps with
their own `origin`, even when stored with `isMeta`. Skill bodies, command
expansions and other `isMeta` entries with no `origin` are system steps. See [ADR 0004](./docs/adr/0004-every-claude-code-entry-becomes-a-step-or-a-counted-diagnostic.md).

## Read a whole session after a /clear

```ts
const store = new ClaudeCodeStore({ root: join(homedir(), '.claude') });
const session = await store.session(process.env.CLAUDE_CODE_SESSION_ID);
const { sessions, missing } = await store.chain(session); // oldest first, linked by derived-from entries
```

`missing` names each id the chain points to whose transcript is no longer in the
store. Each segment reads as its own trajectory. All segments share one `session_id`
(the first id of the chain), and each one names the next in
`continued_trajectory_ref`. See [ADR 0007](./docs/adr/0007-a-clear-chain-is-separate-trajectories-that-share-session-id-and-link-by-continued-trajectory-ref.md).

## Mine every session since a date

```ts
const store = new ClaudeCodeStore({ root: join(homedir(), '.claude') });
const adapter = new ClaudeCodeAdapter();
for await (const { session, cwd } of store.sessions({
  since: new Date('2026-11-20'),
})) {
  // cwd comes from the transcript's first 64 KB, without a full read
  const { trajectory, diagnostics } = await adapter.read(session);
  // …
}
```

## Read Codex history

```ts
const store = new CodexStore({ root: join(homedir(), '.codex') });
const adapter = new CodexAdapter();
for await (const thread of store.threads({ since })) {
  const { trajectory } = await adapter.read(thread); // .jsonl and .jsonl.zst
}
```

## Write your own adapter

```ts
import type { Adapter, ReadResult } from '@deepagents/trajectory';

class GooseAdapter implements Adapter<GooseSession> {
  readonly agent = 'goose';
  async read(session: GooseSession): Promise<ReadResult> {
    // Read the store, then return { trajectory, diagnostics } in ATIF v1.8.
  }
}
```

## Signatures

```ts
// The port.
export interface Adapter<Session> {
  readonly agent: string; // ATIF agent.name: 'claude-code', 'codex', …
  read(session: Session, options?: ReadOptions): Promise<ReadResult>;
}
export interface ReadOptions { subagents?: boolean } // default true
export interface ReadResult { trajectory: Trajectory; diagnostics: Diagnostic[] }
export interface Diagnostic { code: DiagnosticCode; path: string; line?: number; count?: number; entryType?: string; message: string }
export type DiagnosticCode =
  | 'invalid_json_line'    // a line that does not parse
  | 'partial_last_line'    // the agent is still writing it
  | 'unmapped_entry'       // bookkeeping that has no step (counted by type)
  | 'sidechain_entry'      // an isSidechain row inside a main transcript
  | 'orphan_tool_result'   // a result whose call is not in the transcript
  | 'unlinked_subagent'    // a subagent whose spawning call is not found
  | 'unreadable_subagent'; // a subagent transcript that cannot be read

// Claude Code.
export class ClaudeCodeStore {
  constructor(options: { root: string }); // the folder that holds projects/
  sessions(options: { since: Date }): AsyncIterable<ClaudeCodeSessionInfo>;
  session(sessionId: string): Promise<ClaudeCodeSession | undefined>;
  chain(session: ClaudeCodeSession): Promise<ClaudeCodeChain>;
}
export interface ClaudeCodeSessionInfo {
  readonly session: ClaudeCodeSession;
  readonly cwd: string | undefined; // the first cwd of the transcript's first 64 KB; undefined when none, or unreadable
}
export interface ClaudeCodeChain {
  readonly sessions: readonly ClaudeCodeSession[]; // oldest first
  readonly missing: readonly string[]; // ids the chain names whose transcript is gone
}
export class ClaudeCodeSession {
  static fromTranscriptPath(path: string): ClaudeCodeSession; // a main transcript; touches no disk
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly runId: string; // the chain's first id; its own id when read alone
  readonly continuedBy: string | undefined; // the next segment's transcript, from chain()
}
export class ClaudeCodeSubagent {
  static fromTranscriptPath(path: string): ClaudeCodeSubagent; // <session>/subagents/agent-<id>.jsonl
  readonly agentId: string;
  readonly sessionId: string; // the session that started it
  readonly transcriptPath: string;
}
export class ClaudeCodeAdapter implements Adapter<ClaudeCodeSession | ClaudeCodeSubagent> { readonly agent = 'claude-code' }

// Codex.
export class CodexStore {
  constructor(options: { root: string }); // the folder that holds sessions/ and archived_sessions/
  threads(options: { since: Date }): AsyncIterable<CodexThread>;
}
export class CodexThread {
  constructor(threadId: string, rolloutPaths: readonly string[], subagents?: readonly CodexSubagentThread[]);
  readonly threadId: string;
  readonly rolloutPaths: readonly string[]; // the original first, then any a revert wrote
  readonly subagents: readonly CodexSubagentThread[]; // every thread under it, flat
}
export interface CodexSubagentThread { readonly threadId: string; readonly rolloutPaths: readonly string[] }
export class CodexAdapter implements Adapter<CodexThread> { readonly agent = 'codex' }

// ATIF v1.8, ported from Harbor's models (docs/ported-from-harbor-atif.md).
export const ATIF_SCHEMA_VERSION = 'ATIF-v1.8';
export type Trajectory, Step, UserStep, AgentStep, SystemStep, ToolCall, Observation,
  ObservationResult, Metrics, FinalMetrics, Agent, ContentPart, SubagentTrajectoryRef;

// Errors.
export class SessionReadError extends Error { readonly path: string } // missing or unreadable; cause attached
```

## What each call does underneath

| Call                                      | Underneath                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClaudeCodeSession.fromTranscriptPath(p)` | Takes the id from the file name; touches no disk.                                                                                                                                                                                                                                                             |
| `ClaudeCodeStore.sessions({ since })`     | Walks `projects/*/*.jsonl` and yields each main transcript changed since `since`, newest first, with the first `cwd` of its first 64 KB, as the Agent SDK's `listSessions` reads its head. Subagent files are not sessions.                                                                                   |
| `ClaudeCodeStore.session(id)`             | Looks for `projects/*/<id>.jsonl`.                                                                                                                                                                                                                                                                            |
| `ClaudeCodeStore.chain(s)`                | Reads each transcript's `derived-from` entry back to the first segment. It follows every `claude_code_session` it names (any `via`), skips ids already in the chain, looks beside the current transcript first, then in every project.                                                                        |
| `ClaudeCodeAdapter.read(s)`               | Streams the transcript line by line. It maps every entry by the [mapping table](#claude-code-entry--atif), pairs each `tool_use` with its `tool_result` by id, and reads `<id>/subagents/agent-*.jsonl` plus `.meta.json` into `subagent_trajectories`.                                                       |
| `CodexStore.threads({ since })`           | Walks `sessions/` and `archived_sessions/` (`.jsonl`, `.jsonl.zst`), reads each rollout's first line (`session_meta`, decompressing only that far) and groups a subagent thread under its parent with meticulous's rule: the meta's `session_id` when it differs from the thread id, else `parent_thread_id`. |
| `CodexAdapter.read(t)`                    | Decodes `.zst` with `node:zlib` `zstdDecompressSync`, then calls meticulous's `convertCodexSession`, and writes `schema_version: ATIF-v1.8`.                                                                                                                                                                  |

Speed, measured on this Mac on 2026-11-27 (a measurement, not a test: the
repo's `no-wall-clock-bound` rule forbids timing bounds in tests):

- meticulous converts 3 MB plus 6 subagents in 34 ms;
- a whole-file read of 24 h of transcripts (835 files, 311k entries) takes 3.7 s warm.

## Claude Code entry → ATIF

| Entry                                                                                                              | Becomes                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `user` with an `origin` (typed prompts, peer messages, task notifications; `isMeta` or not)                        | `UserStep`; `extra.claude_code.origin` = `origin.kind` (`human`, `peer`, `task-notification`, …)                             |
| `user`, `isMeta`, no `origin` (skill bodies, command expansions)                                                   | `SystemStep`, `extra.claude_code.is_meta: true`                                                                              |
| `user`, text content, no `origin`, not `isMeta` (Claude Code builds before `origin`)                               | `UserStep` with no `extra.claude_code.origin`: its author is unknown, so it never counts as typed                            |
| `user` with `tool_result` blocks                                                                                   | `ObservationResult` on the agent step that made the call; `toolUseResult` goes in `result.extra.claude_code.tool_use_result` |
| `assistant` (entries with one `message.id` merge into one step)                                                    | `AgentStep`: text → `message`, `thinking` → `reasoning_content`, `tool_use` → `tool_calls`, `usage` → `metrics`              |
| `attachment` `queued_command`                                                                                      | `UserStep` with that attachment's `origin` (a prompt typed mid-turn, or a peer message)                                      |
| any other `attachment` (`hook_additional_context`, `hook_success`, …)                                              | `SystemStep`, the attachment in `extra.claude_code.attachment`                                                               |
| `system` (`stop_hook_summary`, `turn_duration`, `compact_boundary`, …)                                             | `SystemStep`, the entry in `extra.claude_code.system`                                                                        |
| `derived-from`                                                                                                     | `Trajectory.extra.claude_code.derived_from`; `chain()` follows it                                                            |
| `ai-title`, `custom-title`, `summary`, `pr-link`                                                                   | `Trajectory.extra.claude_code`                                                                                               |
| `isSidechain` row in a main transcript                                                                             | skipped, counted as `sidechain_entry`                                                                                        |
| bookkeeping (`api-request`, `data-flow-records`, `permission-mode`, `queue-operation`, `file-history-snapshot`, …) | skipped, counted by type as `unmapped_entry`                                                                                 |

Every step keeps `extra.claude_code` with `uuid`, `parent_uuid`, `timestamp`,
`cwd`, `entrypoint` and `prompt_id`, so a consumer can join back to the raw line.

## Errors

- `SessionReadError`: the transcript or rollout is missing or cannot be read or
  decoded. It has one class because the caller's next step is the same either
  way: a hook does not fire, and a miner logs and skips.
- A bad line never throws; it becomes a `Diagnostic`. The last line is often
  half-written while the agent runs.

## The same concepts in other systems

| System                           | Their word                                                                | Ours                                                                           |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Harbor ATIF v1.8                 | `Trajectory`, `Step`, `subagent_trajectories`, `continued_trajectory_ref` | same (the port)                                                                |
| Google ADK (Go)                  | `session.Session` holds `Event`s                                          | `ClaudeCodeSession` is the stored session; the trajectory is what is read back |
| Microsoft Agent Framework (.NET) | `AgentSession` + `ChatHistoryProvider`                                    | the same split                                                                 |
| Claude Agent SDK                 | `listSessions`, `getSessionMessages`, `listSubagents`                     | `ClaudeCodeStore.sessions`, `ClaudeCodeAdapter.read`                           |
| Codex app-server                 | thread → turn → item; rollout files                                       | `CodexThread` → `Trajectory`                                                   |
| `@letta-ai/trajectory`           | `listTrajectories`, `normalizeTranscript`                                 | `Store.sessions`, `Adapter.read`                                               |
| franken-agent-detection (Rust)   | `Connector` trait, `NormalizedConversation`                               | `Adapter`, `Trajectory`                                                        |

## Why not an npm package

| Package                                | Why it fails                                                                                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alwaysmeticulous/agent-traces` 3.2.0 | Used here for Codex only. Its Claude converter reads only `user` and `assistant` lines: it drops `queued_command` prompts, system rows, attachments, `toolUseResult` and `/clear` chains, with no extension points. Its output is ATIF v1.7. |
| `@letta-ai/trajectory` 0.4.4           | Closed set of sources, a closed schema with no extra slot, and its own format rather than ATIF.                                                                                                                                              |
| `atifact` 0.16.0                       | Reads `claude -p` stream-json only, not stored sessions.                                                                                                                                                                                     |
| `@kontourai/thread` 0.7.0              | Its own format, and young.                                                                                                                                                                                                                   |
| `@anthropic-ai/claude-agent-sdk`       | Claude only; one reader per agent was rejected. Its messages drop attachments and system rows; its raw store API is alpha.                                                                                                                   |
| franken-agent-detection (crate)        | Rust only, and it also drops attachments, system rows and `toolUseResult`.                                                                                                                                                                   |

## Who uses what

| Consumer                                                                                      | Uses                                                                                                      |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| agent-plugin `hooks/compile-guard`                                                            | `fromTranscriptPath`, `read({ subagents: false })`, agent `tool_calls`                                    |
| agent-plugin `hooks/ezzs-way-of-coding` stop and verification rules                           | `read`, user steps by origin, system steps (`stop_hook_summary`), last agent message, subagent transcript |
| deepagents `experimental/coding-agent-reminders`                                              | `read`, user steps by origin, `hook_additional_context` system steps                                      |
| agent-plugin housekeeping `close-check` / `records-check`                                     | `ClaudeCodeStore.chain`, tool calls with results and `tool_use_result`                                    |
| agent-plugin update-docs evidence                                                             | `sessions({ since })`, typed prompts, agent text and tool calls, `cwd`                                    |
| later: context-compiler sessions connector (#2400), rollover resume (#6075), night-run miners | `sessions({ since })`, `read`                                                                             |
