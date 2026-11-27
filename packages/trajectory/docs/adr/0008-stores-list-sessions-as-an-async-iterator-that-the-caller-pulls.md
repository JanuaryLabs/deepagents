# Stores list sessions as an async iterator that the caller pulls

Status: proposed, for review (deepagents #6107).

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
