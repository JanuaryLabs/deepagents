# Zukhruf dynamic subagents demo

A minimal code-defined root agent with Markdown specialists and a Markdown
feature-development skill.

At startup, the `coding-team` plugin contributes the `subagents/` directory and
the `feature-development` skill directory. Zukhruf reads both once, validates
the declarations, namespaces the specialists as `coding-team:<name>`, and
installs the skill only for the code-defined root agent that selects it.
Zukhruf then supplies independent durable conversations, collaboration tools,
mailboxes, waiting, and result delivery.

This keeps the split at the intended boundary:

- Code owns the root agent and executable dependencies.
- `instructions.ts` owns the root's prompt fragments.
- `sandbox.ts` owns the per-conversation Docker sandbox.
- Markdown owns specialist identity, description, and instructions.
- The plugin's `agents` and `skills` fields provide the declarations available
  to the runtime.
- An agent's `skills` field selects only the plugin skills that agent receives.
- `AgentRuntime` owns multi-agent execution and durable coordination.

Plugin declarations are a startup snapshot. Add or edit a Markdown agent or
skill, then restart the process.

A Markdown specialist opts into a contributed skill by name:

```md
---
name: reviewer
description: Reviews implementation changes.
skills:
  - code-review
---
```

`channels/`, `connections/`, `schedules/`, and `tools/` are reserved
declaration slots. `skills/` and `subagents/` contain the declarations this
demo actually uses.

## Run

Requirements: Node.js, Docker, and `OPENAI_API_KEY`.

```sh
OPENAI_API_KEY=... node demo/zukhruf-dynamic-subagents/run.ts \
  --workspace /absolute/path/to/repository \
  "Add a health endpoint following the repository's existing conventions"
```

Each agent receives its own Docker sandbox. The target repository is mounted at
`/agent/workspace`. Zukhruf copies the selected skill into the root agent's
`/agent/skills` directory; specialists do not receive it.

Every agent can modify files under the selected workspace and its sandbox has
network access. Run it only on repositories and prompts you trust.

## Verify

```sh
nx run @deepagents/demo-zukhruf-dynamic-subagents:typecheck
nx run @deepagents/demo-zukhruf-dynamic-subagents:test
```
