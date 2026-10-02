# Phase 4 — DevTool, demo, and final verification

Status: complete. Dependency: [Phase 3](./phase-3-usage-baseline.md).

## Outcome

A user can see why compaction ran and interpret its counts as estimated request
size. The demo proves the path live, and the documentation describes the final
contract. Earlier phases must already have passed their acceptance checks.

## Owned files

- `packages/devtool/host/ui/src/routes/chat-compaction.tsx` and
  `chat-compact.test.tsx`.
- Existing `CompactionEvent` definition/emission if final display needs a minimal
  additional field; do not add a second event transport or accounting store.
- `packages/compaction/README.md`, relevant compaction paragraphs of
  `packages/experimental/src/zukhruf/DESIGN.md` and root docs.
- `demo/zukhruf-simple/agent.ts` and its README only as needed for a viable
  full-input budget and accurate instructions.

## Work

1. Render new request-scope counts as **estimated input tokens** and the target
   as an **estimated input target**. A saved checkpoint is still a success;
   estimated counts must not be presented as billed usage or exact model tokens.
2. New started/completed event counts must share request scope. Package result
   counts remain message scope; do not relabel them without adding the envelope.
   Read older persisted events without a scope marker as message estimates.
3. Preserve grouping by attempt ID, prompt flushing of started events, native
   stream persistence, completed/failed/restored states, and interrupted display
   after cancellation. No raw prompts, summary text, or credential-bearing
   request bodies enter lifecycle metadata.
4. Review the demo's real normalized instruction/tool envelope. Its current
   4,000 target may be smaller than that envelope. If so, choose and document
   a viable target and a higher token threshold based on that observed estimate;
   do not invent numbers here or silently weaken the runtime contract.
   Keep `messagesExceed(40)` and the existing cache trigger demonstrable.
5. Update examples and API comments to distinguish standalone message budgets
   from runtime input budgets, explain custom counter precedence, baseline
   invalidation, unsupported media, and estimate limitations.
6. Run a deterministic public runtime-to-stream-to-DevTool flow that crosses a
   trigger, writes a checkpoint, reopens the chat, then recreates the runtime and
   reuses a valid checkpoint/baseline. Verify original history remains visible.
7. Start the existing demo and verify the actual DevTool page. Use controlled
   fixtures for required assertions; make a bounded live model smoke test only
   when already authorized. Report exactly what was fixture-backed versus live.
   The previous port was 4317; confirm the running server instead of assuming it.

## Acceptance checks

- [x] New events show estimated full-input counts, not raw message-only results.
- [x] Historical events keep their original message-count meaning after reopening.
- [x] Completed, failed, restored and interrupted display still works; data events
      survive persistence and never become model messages.
- [x] A below-target message-count trigger still produces a real attempt and a
      valid checkpoint if safe reduction succeeds.
- [x] The configured demo target leaves positive room after its actual envelope;
      accounting itself makes no token-count API calls or model-catalog requests.
- [x] Restart, checkpoint restore, usage-baseline reuse/invalidation, failure and
      cancellation have public integration evidence recorded in the phase files.
- [x] Compaction no longer depends on `gpt-tokenizer`; other consumers are intact.
- [x] Documentation contains no claim of exact cross-model capacity enforcement.

## Verification

Run each affected target once after final changes; broaden only for a concrete
changed dependency or an unresolved failure. Use Nx, not raw `tsc`.

```sh
npx nx run @deepagents/compaction:typecheck
npx nx run @deepagents/compaction:test
npx nx run @deepagents/experimental:typecheck
npx nx run @deepagents/experimental:test --args="--test-timeout=60000 src/zukhruf/runtime/compaction.integration.test.ts"
npx nx run @deepagents/devtool-ui:typecheck
npx nx run @deepagents/devtool-ui:test --run src/routes/chat-compact.test.tsx
npx nx run @deepagents/demo-zukhruf-simple:typecheck
```

Recheck inferred Nx targets before running: DevTool UI uses the Nx/Vitest plugin;
the demo uses package-script/inferred targets. If context code changed, run its
focused preparation tests and any affected stream-persistence tests through Nx.
Verify the demo build path needed to serve the updated UI. Do not report a
successful old build as proof of the new source.

## Evidence and final handoff

Verified 2026-09-22:

| Check                                                                              | Result                                                                  | Log                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| `nx run @deepagents/compaction:test`                                               | 22 passed                                                               | `/tmp/compaction-final-package-test.log` |
| `nx run @deepagents/experimental:test` with the Phase 2 command override           | 18 passed, zero failures                                                | `/tmp/compaction-final-runtime-test.log` |
| `nx run @deepagents/context:test` with focused branching/preparation command below | 27 passed                                                               | `/tmp/compaction-context-test.log`       |
| `nx run @deepagents/devtool-ui:test --run src/routes/chat-compact.test.tsx`        | 4 passed                                                                | `/tmp/compaction-devtool-test.log`       |
| `nx run @deepagents/demo-zukhruf-simple:typecheck`                                 | Passed, including compaction/context/experimental dependency typechecks | `/tmp/compaction-final-typecheck.log`    |
| `nx run @deepagents/devtool-ui:typecheck`                                          | Passed                                                                  | `/tmp/compaction-ui-typecheck.log`       |
| `nx run @deepagents/devtool:build`                                                 | Passed, includes updated UI                                             | `/tmp/compaction-devtool-build.log`      |
| `git diff --check`                                                                 | Passed                                                                  | No whitespace errors                     |

Focused context invocation (no Docker-backed suites):

```sh
NX_DAEMON=false npx nx run @deepagents/context:test --command="node ../../tools/src/run-node-tests.ts ../../test-results/context-branching.xml --experimental-test-module-mocks --test-timeout=60000 test/sqlite/branching.test.ts src/lib/prepare-step-input.integration.test.ts"
```

Runtime integration crosses both triggers in real tool loops, persists/replays
native data parts through HTTP, reopens transcripts and recreates hosts. UI
integration consumes the SDK data stream and proves live/completed/replayed,
failed/interrupted/restored and historical-event rendering. New events say
estimated input tokens; historical unmarked events say estimated message tokens.
These are deterministic mocked-model checks, not paid model calls.

A separate public runtime probe used the actual demo declaration, Microsandbox,
skills and MCP tool catalog, with a mocked response. A greeting measured 11,411
estimated input tokens, 41 prepared tools and 44,621 serialized prompt/tool
characters. That demonstrated the old 4,000 target was impossible. The demo now
uses a 16,000 estimated input target and 24,000 trigger, retaining the message
threshold of 40 and cache-age trigger. Probe log: /tmp/compaction-demo-envelope.log.
The sandbox initially needed access to its migration lock outside the workspace;
rerunning with approved local filesystem access passed. No workaround was added.

The updated real demo is running at **http://127.0.0.1:4317/devtool/history**:

```sh
node --env-file=.env demo/zukhruf-simple/server.ts
```

Process session at verification: 50418; log /tmp/compaction-demo-server.log.
The in-app browser loaded Zukhruf Devtool and its existing conversation history;
the tab was left open. No model was called from that browser smoke check.
The temporary probe was removed. There is no alternate demo entry point.

## Remove-code audit

- Removed: compaction's GPT-tokenizer import, package dependency, lockfile edge and
  bundler external. The default is the approved JSON-length estimate; the existing
  custom counter and opaque-content guard remain.
- Reused: SDK public schema conversion and lifecycle hooks, existing context
  preparation, checkpoint metadata updates, scope/prefix hashing, native data
  stream persistence, and current DevTool component.
- Added only the required request-envelope/baseline logic and scope display. No
  counter registry, middleware framework, provider client, transport or store.
- Compared with the scoped pre-edit snapshot: production TypeScript +166/-46
  (net +120); tests +601/-5 (net +596). Growth implements the approved request and
  durability contract; replacing the GPT import alone could not do that.
- Retained dependency: packages/context still legitimately imports gpt-tokenizer;
  its separate API issue remains backlog #1958. No unrelated removal claimed.
- Rejected/deferred: native provider compaction and exact provider counting are
  outside scope. Provider framing, code-mode wrappers, language accuracy and
  unobservable routing/middleware changes remain estimate limitations.
- Required adjacent fix: initialize ContextEngine's branch name from its loaded
  branch so restored baseline identity is stable. Both runtime and SQLite flows
  reproduced the mismatch and now pass.
- No staging, commits, new dependencies or memory writes. Existing dirty/untracked
  work preserved. No remaining implementation step in this plan.
