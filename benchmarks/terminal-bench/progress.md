# Terminal-Bench Progress

## Completed

### Research & Understanding (2026-04-07)

- Researched Terminal-Bench architecture: tasks, harness, scoring (binary pass/fail)
- Discovered TB 1.0 (legacy, `tb` CLI) vs TB 2.0 (live, Harbor framework)
- Fetched full TB 2.0 leaderboard (123 entries, top at 81.8%)
- Studied two reference implementations:
  - **Letta agent** (~200 lines, TB 1.0 BaseAgent, #1 open-source) — observe-act loop, 3 custom tools, persistent scratchpad. Note: uses TB 1.0 interface (`perform_task` + `TmuxSession`), not Harbor's `async run` + `BaseEnvironment`. Patterns transfer, API does not.
  - **Terminus-2** (built-in harness) — JSON/XML parsers, proactive summarization, context unwinding
- Identified 7 high-impact harness engineering techniques (context injection, self-verification, reasoning sandwich, loop detection, environment bootstrap, persistent scratchpad, proactive summarization)

### Setup & Smoke Tests (2026-04-07)

- Installed `terminal-bench` CLI v0.2.18 (TB 1.0 — legacy, but useful for learning)
- Ran smoke test with Qwen 3.5 9B via LM Studio
  - `terminus` (v1) agent failed — `response_format: json_object` incompatible with LM Studio
  - `terminus-2` with `parser_name=xml` worked — agent successfully attempted kernel build task
- Discovered local model gotchas:
  - Reasoning models (Qwen 3.5) burn all tokens on thinking before producing output
  - LM Studio rejects `response_format: json_object` (only supports `json_schema` or `text`)
  - Fix: use XML parser or `openai_compatible/` litellm prefix

### Documentation (2026-04-07)

- Wrote `terminalbench.md` as source-of-truth covering:
  - TB 2.0 + Harbor as the target
  - Harbor agent interface (BaseAgent, BaseInstalledAgent)
  - Submission requirements (HuggingFace PR, 5 trials, no timeout overrides)
  - Leaderboard data, harness techniques, reference implementations
  - Local model notes

---

## Remaining

### Phase 1: Harbor Setup

- [x] Install Harbor v0.3.0 (`uv tool install harbor`)
- [x] Verify setup with oracle agent (2/2 tasks, reward 1.0)
- [ ] Run terminus-2 baseline with a frontier model to get a reference score

### Phase 2: Custom Harness Development

- [x] Scaffold TypeScript harness in benchmarks/terminal-bench/src/
- [x] Python shim (shim/tbench_shim.py) bridging Harbor BaseAgent -> Node stdio
- [x] Bridge (src/bridge.ts) for stdio JSON lines IPC
- [x] Agent loop (src/agent.ts) using agent() from @deepagents/context
- [x] Tools: run_commands + task_complete (src/tools/definitions.ts)
- [x] System prompt builder using @deepagents/context fragments
- [x] nx project.json with bench target (dependsOn: ^build)
- [ ] End-to-end verification (running)
- [ ] Add context injection middleware (discover environment at startup)
- [ ] Add self-verification step (verify before signaling completion)
- [ ] Add loop detection (detect and break repetitive actions)
- [ ] Add persistent scratchpad / planning memory
- [ ] Add proactive summarization for long tasks

### Phase 3: Model Selection

- [ ] Decide on model(s) to target (cloud API vs local)
- [ ] Test harness with chosen model on subset of tasks
- [ ] Iterate on harness based on failure analysis

### Phase 4: Full Benchmark Run

- [ ] Run full benchmark: 89 tasks, 5 trials each (`-k 5`)
- [ ] Analyze results: pass/fail per task, failure modes, token usage
- [ ] Iterate on harness for failing tasks

### Phase 5: Leaderboard Submission

- [ ] Fork HuggingFace repo
- [ ] Structure results: `submissions/terminal-bench/2.0/<agent>__<model>/`
- [ ] Write `metadata.yaml`
- [ ] Open PR, pass auto-validation
- [ ] Get merged, appear on leaderboard
