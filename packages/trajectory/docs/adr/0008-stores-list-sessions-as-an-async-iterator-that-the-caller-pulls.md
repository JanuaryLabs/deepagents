# Stores list sessions as an async iterator that the caller pulls

Status: ruled by Ezz on 2026-11-27 (deepagents #6107). Amended on 2026-11-27 while building: `read()` reads the transcript whole and splits it into lines instead of streaming it. The measurement above has whole-file reads at 3.7 s and streamed `readline` at 3.9 s, and a trajectory is returned whole either way. Listing (`sessions()`) still walks the folders lazily and reads no transcript content. Amended again on 2026-11-27 (agent-plugin #6100 P6): `ClaudeCodeStore.sessions()` yields `ClaudeCodeSessionInfo { session, cwd }`, the first `cwd` of each transcript's first 64 KB, as the Claude Agent SDK 0.3.331 `listSessions` returns `SDKSessionInfo` with `cwd` from a 64 KB head read. update-docs finds the repos sessions ran in from the first `cwd` of all 18,769 transcripts (7.2 GB) on Ezz's Mac: a head read of 219 sessions takes 219 ms, a full `read()` 8,758 ms. Over all 18,768 real transcripts the listing gives the same `cwd` as update-docs' own chunked reader for 18,767, in 32 s; the one other records its first `cwd` at byte 90,557, and 86 other sessions of its project give the same folder. A transcript the process cannot open is still listed, with no `cwd`.

## Context

The leaders list sessions three ways:

| Leader           | Shape                                             |
| ---------------- | ------------------------------------------------- |
| franken          | push: `scan_with_callback(ctx, on_conversation)`  |
| letta            | paged pull: `listTrajectories({ cursor, limit })` |
| Claude Agent SDK | paged pull: `listSessions({ limit, offset })`     |
| meticulous       | whole arrays: `findTraceSessions`                 |

Measured on 2026-11-27 over 24 h of real transcripts (835 files, 311k entries, warm cache):

| Reading              | Time                                         |
| -------------------- | -------------------------------------------- |
| Whole-file read      | 3.7 s (and 350 MB of memory on the cold run) |
| Pulled `readline`    | 3.9 s (156 MB)                               |
| Pushed stream events | 5.6 s                                        |
| franken push (Rust)  | 1.1 GB in 8.1 s, with conversion             |

JSON parsing dominates, so the shape does not decide speed.

## Decision

- `sessions({ since })` and `threads({ since })` return `AsyncIterable`. They yield newest first and walk the folder lazily.
- `read()` streams the file line by line and returns the whole trajectory.

## Consequences

- A miner can `break` early, and memory stays at one session.
- A caller that wants pages or a cursor (the #2400 warehouse wants a byte offset per file) builds it on top.
- A byte-offset incremental read is "later".
