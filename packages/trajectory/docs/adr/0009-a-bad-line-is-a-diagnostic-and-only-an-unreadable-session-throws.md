# A bad line is a diagnostic, and only an unreadable session throws

Status: proposed, for review (deepagents #6107).

## Context

A running agent is often writing the transcript's last line. The current readers skip an unparsable line, and a missing or unreadable transcript makes a rule not fire, with the error logged (`coding-agent-reminders`, deepagents 84335c5b). letta returns `diagnostics` with codes beside its records. The Claude Agent SDK returns an empty list for a missing session.

## Decision

- `read()` returns `{ trajectory, diagnostics }`. The diagnostic codes are:
  - `invalid_json_line`
  - `partial_last_line`
  - `unmapped_entry`
  - `sidechain_entry`
  - `orphan_tool_result`
  - `unlinked_subagent`
- `SessionReadError` (with `path` and `cause`) is the one thrown class. It covers a missing file, a read error and a zstd decode error, because the caller's next step is the same for all three: a hook does not fire, and a miner logs and skips.
- `store.session(id)` returns `undefined` for an unknown id rather than throwing.

## Consequences

- Hooks catch one class.
- An empty transcript (one with no steps) is a `SessionReadError` too, because ATIF requires at least one step.
