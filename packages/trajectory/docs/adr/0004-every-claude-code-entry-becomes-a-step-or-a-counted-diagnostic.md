# Every Claude Code entry becomes a step or a counted diagnostic

Status: ruled by Ezz on 2026-11-27 (deepagents #6107).

## Context

A Claude Code transcript holds more than messages. A session read on 2026-11-27 had user and assistant entries plus:

- `attachment` entries: `hook_success`, `queued_command`, `hook_additional_context`, `prompt_snapshot`, `skill_listing`, …
- `system` rows: `stop_hook_summary`, `turn_duration`.
- `derived-from`, titles, and bookkeeping: `api-request`, `data-flow-records`, `permission-mode`, `queue-operation`, `file-history-snapshot`, ….

The current readers depend on three of these signals: the reminders dedupe reads `hook_additional_context`, the housekeeping gate reads `stop_hook_summary`, and the current-turn rule reads `queued_command`. Every reader surveyed drops at least one of them silently: meticulous, letta and franken alike.

## Decision

- **User steps:** a `user` entry with string content that is not `isMeta`, and a `queued_command` attachment, become a `UserStep`. `extra.claude_code.origin` holds `origin.kind`, so a typed prompt is `origin === 'human'`.
- **Injected context:** an `isMeta` user entry (a skill body or a command expansion) becomes a `SystemStep` marked `is_meta`.
- **Attachments and system rows:** every other attachment and every `system` row becomes a `SystemStep` that carries the original object in `extra.claude_code.attachment` or `extra.claude_code.system`.
- **Tool results** land on the calling agent step's observation, with `toolUseResult` in the result's `extra`.
- **Session-level entries:** `derived-from`, titles and `pr-link` go to `Trajectory.extra.claude_code`.
- **Skipped but counted:** bookkeeping becomes an `unmapped_entry` diagnostic counted by type, and an `isSidechain` row in a main transcript becomes a `sidechain_entry` diagnostic.
- **Join keys:** each step keeps `uuid`, `parent_uuid`, `timestamp`, `cwd`, `entrypoint` and `prompt_id` in `extra.claude_code`.

## Ruled on review

- **Rewinds: file order.** The steps follow the file, as all of today's readers do, so a rewind's abandoned branch stays visible to miners: a rewind is a correction signal. Rejected: the active branch only, which the Claude Agent SDK builds through `parentUuid`. `parent_uuid` is kept on each step, so a consumer can rebuild the active branch.
- **Noisy attachments: system steps.** `hook_success` and every other attachment become system steps. Rejected: counting them as diagnostics and mapping only the known attachment types.

## Consequences

- Nothing is dropped without a count.
- Hook-noise attachments (`hook_success`, about 60 a session) make system steps. A consumer filters them by `attachment.type`.
