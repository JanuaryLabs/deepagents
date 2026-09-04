# Zukhruf dynamic subagents demo

A minimal code-defined root agent with Markdown specialists and a Markdown
feature-development skill.

At startup, Zukhruf's `fileAgents` plugin reads every immediate
`subagents/*.md` file, validates each filename against its frontmatter,
sorts the specialists, and extends the code-defined root declaration. Zukhruf
then supplies independent durable conversations, collaboration tools,
mailboxes, waiting, and result delivery.

This keeps the split at the intended boundary:

- Code owns the root agent and executable dependencies.
- `instructions.ts` owns the root's prompt fragments.
- `sandbox.ts` owns the per-conversation Docker sandbox.
- Markdown owns specialist identity, description, and instructions.
- `fileAgents` composes specialists into the declaration graph.
- `AgentRuntime` owns multi-agent execution and durable coordination.
- `defineSandbox` exposes `skills/feature-development/SKILL.md` through native
  per-conversation skill discovery.

Discovery is a startup snapshot. Add or edit a Markdown agent, then restart the
process.

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

The root defaults to `gpt-5.6-luna`; discovered specialists inherit its exact
model and sandbox. Override the model with `OPENAI_MODEL`.

Each agent receives its own Docker sandbox. The target repository is mounted at
`/agent/workspace`. The demo skill is mounted read-only at `/agent/skills`,
where Zukhruf discovers it without copying files into or hiding paths in the
target repository.

Every agent can modify files under the selected workspace and its sandbox has
network access. Run it only on repositories and prompts you trust.

## Verify

```sh
nx run @deepagents/demo-zukhruf-dynamic-subagents:typecheck
nx run @deepagents/demo-zukhruf-dynamic-subagents:test
```
