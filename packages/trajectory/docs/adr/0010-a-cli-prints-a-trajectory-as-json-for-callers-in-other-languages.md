# A CLI prints a trajectory as JSON for callers in other languages

Status: decided on 2026-11-28 from the leaders, under Ezz's standing rule to follow the leading tools.

## Context

agent-plugin's `coding/mods/e2e.py` is Python and needs to read Claude Code transcripts. Without a CLI it would need a second reader, which ADR 0003 rules out. The tools that read agent sessions into a shared format serve callers in other languages in these ways:

| Tool                                   | How a non-JS caller reads a session                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| franken-agent-detection (Rust)         | its `--robot` mode prints machine-readable output                                                                                         |
| Harbor                                 | `harbor-atif2otel` 0.1.1, a separate converter for ATIF trajectories                                                                      |
| `atifact` 0.16.0                       | its `atifact <file> --json` bin prints the trajectory on stdout; exit 2 means bad arguments or a missing file, and exit 1 a runtime error |
| `@alwaysmeticulous/agent-traces` 3.2.0 | library only (no `bin`)                                                                                                                   |
| `@letta-ai/trajectory` 0.4.4           | library only (no `bin`)                                                                                                                   |

Each leader that serves other languages does it with a process that prints JSON. None of them uses bindings or a server.

## Decision

- The package ships one bin, `trajectory`. Its only command is `trajectory read claude-code <transcript.jsonl>`.
- It reads the file with `new ClaudeCodeAdapter().read(ClaudeCodeSession.fromTranscriptPath(path))` using the default options, so subagents are included. It prints `JSON.stringify({ trajectory, diagnostics })` and a newline on stdout, and exits 0.
- The agent comes before the path, named as `Adapter.agent` names it. A later agent becomes another word (`read codex <rollout>`) and leaves this command unchanged. Codex is not added until a caller needs it.
- Exit 2 has two causes, as with atifact. A `SessionReadError`, or the `TypeError` for a path that is not a main transcript, prints `trajectory: <message>` on stderr. A wrong command, agent, option or argument count prints the one-line usage. Any other error is a bug and crashes with exit 1.
- The bin is built by its own `build-cli` target (esbuild, packages external), after the text2sql precedent. It bundles the library code it uses, and `@alwaysmeticulous/agent-traces` stays a runtime dependency.

## Consequences

- A Python caller runs `npx --yes --package=@deepagents/trajectory@<version> trajectory read claude-code <path>` and parses stdout, so it reads transcripts the same way the TypeScript consumers do.
- The JSON is the ATIF trajectory plus the package's `Diagnostic` objects, so a change to either type changes the CLI's output.
- Each run starts a Node process. A caller that reads many sessions pays that start-up cost on every read.
