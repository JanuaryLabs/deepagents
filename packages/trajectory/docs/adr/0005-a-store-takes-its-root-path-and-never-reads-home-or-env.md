# A store takes its root path and never reads HOME or env

Status: ruled by Ezz on 2026-11-27 (deepagents #6107).

## Context

Every reader surveyed finds the store on its own:

- letta defaults to "the source's standard local location";
- the Claude Agent SDK reads `CLAUDE_CONFIG_DIR`;
- franken probes `~/.claude`, `~/.config/claude` and the Claude Desktop folders.

The maintainer's libraries take the clock, env and paths as required inputs with no default (zukhruf ADR 0004, coding:lib-creator step 3). Tests need fixture roots. A sandboxed run has a different home.

## Decision

- `new ClaudeCodeStore({ root })` and `new CodexStore({ root })` require the root. The package never reads `os.homedir()`, `process.env` or the clock.
- `sessions({ since })` takes the time as a `Date`.

## Consequences

- A test opens a fixture folder.
- A caller writes `join(homedir(), '.claude')` once. Claude Desktop's session folders are a second root the caller can open the same way.
