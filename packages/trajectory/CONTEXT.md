# Trajectory: glossary

> Design for review: no code yet.

- **Trajectory**: the ordered record of one agent run, read back from storage, in ATIF v1.8. It holds steps, an agent, final metrics, embedded subagent trajectories and `extra`. (Sutton & Barto ch. 3; Harbor RFC 0001.)
- **Step**: one entry of a trajectory. Its `source` is `user`, `agent` or `system`. Only an agent step carries a model name, reasoning, tool calls and metrics.
- **Session**: what an agent stores for one run, before it is read. In Claude Code that is one transcript file plus its subagent files; in Codex, one or more rollout files of one thread.
- **Transcript**: Claude Code's JSONL file of one session (`projects/<project>/<session-id>.jsonl`).
- **Rollout**: Codex's JSONL file of one thread (`sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`).
- **Store**: an agent's folder of sessions, opened at a root path the caller gives (`~/.claude`, `~/.codex`).
- **Adapter**: the code that turns one located session of one agent into one trajectory. It is the package's port; an agent the package does not cover gets an adapter of its own.
- **Subagent trajectory**: a run that the session's agent started, embedded in `subagent_trajectories` and referenced from the tool result that started it.
- **Chain**: the segments of one Claude Code session across `/clear`. Each new transcript names the old one in a `derived-from` entry. The segments share one `session_id` and link by `continued_trajectory_ref`.
- **Origin**: who wrote a user step, from Claude Code's `origin.kind`: `human` (typed), `peer` (another session), `task-notification`, `coordinator` (a hand-back), and so on. It lives in `extra.claude_code.origin`.
- **Typed prompt**: a user step whose origin is `human`. It includes a prompt typed mid-turn (a `queued_command` attachment).
- **Injected context**: text the harness adds rather than a person: `isMeta` entries such as skill bodies and command expansions, and attachments such as `hook_additional_context`. These are system steps.
- **Diagnostic**: a counted, non-fatal note about a line the adapter could not map (a bad or partial line, bookkeeping, a sidechain row, an orphan result).
