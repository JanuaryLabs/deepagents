# The ATIF types port Harbor's Pydantic models and split Step by source

Status: ruled by Ezz on 2026-11-27 (deepagents #6107).

## Context

Harbor publishes ATIF as Pydantic models (`src/harbor/models/trajectories`) with a validator, but no JSON Schema and no TypeScript types. meticulous ships TypeScript types for v1.7 with the version as a literal, so a v1.8 document does not type-check against them.

Harbor's `Step` rejects `model_name`, `reasoning_effort`, `reasoning_content`, `tool_calls` and `metrics` on any step whose `source` is not `agent` (`step.py`, `validate_agent_only_fields`).

## Considered options

- **Depend on meticulous's types.** Rejected: they are pinned to v1.7 and belong to Meticulous's ingest.
- **One `Step` interface with every field optional.** Rejected: a user step with tool calls could be built.
- **Port the models field for field, snake_case kept, with `Step` as a union of `UserStep | AgentStep | SystemStep`.** This option was selected.

## Decision

- Each model is ported with its name, fields and optionality exactly. `extra` is `Record<string, unknown>`.
- The agent-only rule becomes the type: only `AgentStep` has those fields.
- `ATIF_SCHEMA_VERSION = 'ATIF-v1.8'`.
- The field-by-field map is in [ported-from-harbor-atif.md](../ported-from-harbor-atif.md).

## Consequences

- An illegal step does not compile.
- A JSON validator (zod or similar) is "later". The first release type-checks what it builds and does not validate foreign input.
