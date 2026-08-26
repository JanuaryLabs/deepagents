# Codex standalone Scheduled: powering-framework contract

Research snapshot: 2026-08-13. This is a behavioral contract for the execution framework and host control plane, not a UI specification.

## Conclusion

Codex Scheduled is not just "run an agent when a timer fires." It is a host-owned scheduler/control plane wrapped around a normal fresh-root agent runtime:

```text
durable schedule -> due-occurrence claim -> durable run record
                 -> fresh root task -> ordinary agent turn
                 -> completion/result projection -> reviewable run
```

Therefore Eve can power Codex-style schedules **without losing the agent-execution semantics** only if Eve can start a fully configured fresh root task and expose its lifecycle/results. Eve alone is **not** a lossless replacement if it lacks the host-owned durable schedule registry, occurrence claiming, run ledger, recovery, policy selection, and environment isolation listed below. Those responsibilities may live beside Eve; they do not need to live inside its model loop.

The current repository contains no package, dependency, or public surface named Eve, so this pass cannot verify Eve's exact parity. The checklist below is the concrete interface Eve would need to satisfy.

## Evidence matrix

| Capability | Contract a powering framework must preserve | Primary evidence |
|---|---|---|
| Ownership | A standalone schedule is a host-owned resource, not a message owned by an existing task. The stored definition has its own stable ID, name, prompt, active/paused status, RRULE, execution target/environment, model, reasoning effort, and timestamps. | Official [Scheduled tasks](https://learn.chatgpt.com/docs/automations). Installed `/Applications/ChatGPT.app/Contents/Resources/app.asar`, extracted `src-Cz_uUmVl.js`: TOML schema and `BN`/`VN` create-update functions; live examples under `$CODEX_HOME/automations/<id>/automation.toml`. |
| Fresh root per run | Every standalone occurrence starts a new persisted root task/chat. It does not resume or enqueue onto a previous run's task. The root is started with `threadSource: "automation"`, then the saved prompt becomes its first turn. | Official docs explicitly say each standalone run starts a new chat. Installed `app.asar`, extracted `main-DJC9FKq9.js`: `Ua` calls `startThread(...)` on every target/run and then `startTurn(...)`; no prior thread ID is read from the schedule. |
| Schedule persistence | Definitions survive restart independently of run conversations. The installed app treats `$CODEX_HOME/automations/<id>/automation.toml` as authoritative and mirrors mutable cursors (`next_run_at`, `last_run_at`) in SQLite. TOML writes are temporary-file-plus-rename. | Installed `app.asar`, extracted `src-Cz_uUmVl.js`: `GM`, `KM`, `gN`, `_N`, `vN`, `yN`, `bN`, `PN`, and `automations` migration. |
| Run ledger | A run exists before its real task ID exists: insert an `IN_PROGRESS` row keyed by a unique `pending:<uuid>`, replace it with the real thread ID after thread creation, and retain title/summary/read/archive metadata. | Installed `app.asar`, extracted `main-DJC9FKq9.js` `Ua`; extracted `src-Cz_uUmVl.js` `pA`, `Ate`, `automation_runs` migration. |
| Completion/result reporting | Turn completion transitions the run from `IN_PROGRESS` to `PENDING_REVIEW`. The agent must emit one structured inbox result (`title`, `summary`), which is projected into the run record. Review state is separate from the underlying turn outcome; the turn itself carries completed/failed. | Installed `app.asar`, extracted `main-DJC9FKq9.js` `Rte` instructions and notification routing; extracted `src-Cz_uUmVl.js` `hA`, `bA`, `uoe`. Official docs describe results/findings appearing in Scheduled. |
| Recurrence and timezone | Accept RFC 5545 RRULEs. Wall-clock recurrence is evaluated in local civil time unless an RRULE explicitly supplies `DTSTART;TZID=...`; daily/weekly helpers construct local `Date`s. Advanced `TZID`/`DTSTART` syntax is parsed. Do not reduce the contract to fixed millisecond delays. | Official docs identify RFC 5545 RRULE. Installed `app.asar`, extracted `src-Cz_uUmVl.js` `DN`, `JN`, `YN`, RRULE parser. |
| Misfire/catch-up | On startup, recompute missing cursors. If a recurring schedule is overdue, the due query returns the schedule once; before launch the cursor is advanced from "now" to the next future occurrence. Multiple missed occurrences therefore collapse to one catch-up run, not replay-all. One-shot rules are not recreated after a completed cursor. | Installed `app.asar`, extracted `main-DJC9FKq9.js` scheduler `La`, `za`; extracted `src-Cz_uUmVl.js` `UN`, `WN`, `GN`, `PN`, `kN`. This behavior materially exceeds official documentation. |
| Jitter | Recurring hourly/daily/weekly wall-clock schedules receive deterministic per-schedule, per-occurrence jitter of up to 119 seconds, persisted by a host salt. One-shots and qualifying interval heartbeats are not jittered. | Installed `app.asar`, extracted `src-Cz_uUmVl.js` `jN`, `MN`, `NN`; live `$CODEX_HOME/automations/.run-jitter-salt`. Not documented publicly. |
| Polling/concurrency | The local host polls every 30 seconds, claims at most three due definitions per tick, and launches that batch concurrently. A guard prevents scheduler ticks themselves from overlapping. Targets of one schedule are started serially. There is no same-schedule `IN_PROGRESS` exclusion in the standalone path, so a later occurrence or Run now can overlap an earlier run in another fresh task. | Installed `app.asar`, extracted `main-DJC9FKq9.js`: `Xte = 30000`, `la = 3`, `La`, `Ba`, `Ia`; no run-ledger check in `WN`, `Ra`, or `Ba`. Not documented publicly. |
| Pause/resume/edit | Definitions support `ACTIVE` and `PAUSED`. Pausing nulls `nextRunAt`; resume or a recurrence edit computes a new future time from edit/resume time. Name/prompt/model/reasoning/target changes preserve `lastRunAt`. These actions affect future launches, not an already-running independent task. | Installed `app.asar`, extracted `src-Cz_uUmVl.js` `VN`, `PN`; official docs say active/paused tasks are manageable. |
| Delete | Delete removes the schedule directory and its persisted definition, removes the cursor row, and removes that schedule's run-ledger rows. There is no code in schedule deletion that interrupts already-started tasks. A framework should keep "delete future schedule" distinct from "cancel running task." | Installed `app.asar`, extracted `src-Cz_uUmVl.js` `HN`, `SA`; `main-DJC9FKq9.js` `automation-delete`. The non-cancellation detail exceeds official docs. |
| Cancellation | An already-started run is an ordinary independent root task and must be stopped through the task runtime. Schedule pause/delete/edit does not act as task cancellation. The host should decide whether to expose a combined operation, but keep the two effects independently durable. | Installed `app.asar`: schedule CRUD has no task-interrupt call; `Ua` binds each run to a normal persisted thread. This boundary is not documented publicly. |
| Run now | Run now creates an ordinary fresh standalone run immediately and still computes/advances the schedule's next cursor. It is not a special continuation of the last run, and it has no same-schedule mutual-exclusion guard. | Installed `app.asar`, extracted `main-DJC9FKq9.js` `Ra`, `za`, `Ba`. |
| Crash/restart | On scheduler startup, placeholder `pending:*` runs left `IN_PROGRESS` are archived with reason `auto`; real `IN_PROGRESS` runs are moved to `PENDING_REVIEW`. Due cursors are restored/recomputed. This is durable and reviewable, but not exactly-once: the app advances `lastRunAt`/`nextRunAt` before creating the run/task, so a crash in that window can lose an occurrence; a crash after task creation but before final reconciliation can surface it as reviewable rather than retry it. | Installed `app.asar`, extracted `main-DJC9FKq9.js` `La`, `Ua`; extracted `src-Cz_uUmVl.js` `gA`, `GN`. Not documented publicly. |
| Permissions/approvals | Runs are unattended and derive sandbox/reviewer policy from saved/default project configuration plus admin requirements. Where allowed, user-reviewed modes are converted to `approval_policy = "never"`; otherwise the selected permission mode's behavior remains. Projectless runs are forced read-only. There is no interactive user waiting contract the scheduler can depend on. | Official docs, Permissions and security model. Installed `app.asar`, extracted `main-DJC9FKq9.js` `Ma`, `Pa`, `Ua`. |
| Project targeting | The official product contract allows a standalone task to run across one or more projects. The installed local definition currently holds one saved-project target (or projectless); legacy multi-cwd definitions are split into per-project schedule definitions. The host must resolve targets at run time, and a missing project/folder skips/fails rather than silently retargeting. Exact cross-surface parity therefore needs host-level fan-out or a multi-target aggregate above the local definition. | Official docs. Installed `app.asar`, extracted `main-DJC9FKq9.js` `oa`, `sa`, `Ba`; extracted `src-Cz_uUmVl.js` target schema and legacy migration `SN`. |
| Local isolation | `local` executes directly in the primary project folder and can collide with human edits or other runs. The scheduler itself provides no file-level collision arbitration. | Official docs explicitly warn local mode can modify files being actively edited. Installed `app.asar`, `Ua` starts the root task with the project cwd. |
| Worktree isolation | For Git projects, `worktree` creates a dedicated managed worktree for each fresh run/task, records the task as worktree owner, runs from that cwd, and expands sandbox roots to include source/worktree Git metadata and automation memory. Archive/retention controls worktree cleanup. Non-Git/projectless targets cannot use this mode. | Official [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) and Scheduled docs. Installed `app.asar`, extracted `main-DJC9FKq9.js` `ka`, `Aa`, `ja`, `Ua`. |
| Model/reasoning | Model and reasoning effort are schedule configuration. At launch the host validates against the current model catalog; an unavailable model falls back to the catalog default with a compatible effort rather than making the definition unrunnable. | Official docs allow default or explicit selection. Installed `app.asar`, extracted `src-Cz_uUmVl.js` `ag`; extracted `main-DJC9FKq9.js` `Ba`. |
| Cross-run memory | Fresh root tasks do not inherit prior run chat history. Shared state is explicit: the host tells every run to read/update `$CODEX_HOME/automations/<automation_id>/memory.md`, and grants that directory as a writable root. The prompt also receives `Last run`. Memory failure should not collapse root-task independence. | Installed `app.asar`, extracted `main-DJC9FKq9.js` `Rte`, `Aa`, `Ua`; live `memory.md` files beside schedule definitions. Official docs say standalone runs are independent; the memory mechanism exceeds official docs. |

## Host control plane versus Eve execution substrate

The smallest lossless split is:

### Host-owned scheduler/control plane

- Durable schedule CRUD and ownership.
- RFC 5545 calculation, timezone semantics, deterministic jitter, due scanning, misfire policy, and occurrence claiming.
- Durable schedule cursor and run ledger, including placeholder-to-task-ID binding.
- Pause/resume/edit/delete/run-now policy.
- Crash/startup settlement and idempotency policy.
- Project resolution, local/worktree allocation, permission derivation, model resolution, and managed-policy enforcement.
- Run-result projection, unread/review/archive lifecycle, and worktree retention/cleanup.
- Explicit per-schedule cross-run memory location.

### Eve may provide

- Start a **new root task** with prompt, cwd/workspace roots, tools, model, reasoning effort, sandbox, approval policy/reviewer, and source metadata.
- Persist and expose the task/thread identifier before or atomically with execution.
- Stream lifecycle events and expose terminal turn outcome, final answer, structured result, and cancellation.
- Run independent roots concurrently and keep their context isolated.
- Resume an already-created task only for user follow-up; never reuse it for the next standalone occurrence.

If Eve can do those execution duties, it can power the model/tool loop with no user-visible loss. The host still needs the control plane. Replacing that control plane with the existing conversation scheduler would lose fresh-root isolation, the durable run ledger, review lifecycle, host CRUD semantics, worktree-per-run allocation, and explicit cross-run memory.

## Framework acceptance checklist

- [ ] `startRootTask(config)` returns a durable task ID and never implicitly attaches to a previous run.
- [ ] Configuration includes prompt, source=`automation`, model, reasoning effort, cwd, workspace roots, tools, sandbox, approval policy/reviewer, and optional environment setup.
- [ ] A schedule occurrence and run record are durably claimed before execution; task-ID binding is atomic or recoverable.
- [ ] Duplicate delivery of the same occurrence is idempotent.
- [ ] Terminal events distinguish completed, failed, interrupted, and canceled even if all may enter a review queue.
- [ ] A structured title/summary or equivalent result can be projected without parsing arbitrary prose.
- [ ] Running tasks can be canceled independently of pausing or deleting future recurrence.
- [ ] Startup reconciliation can distinguish never-started placeholders from real interrupted tasks.
- [ ] Concurrent fresh roots are isolated by separate worktrees or explicitly accepted shared-local risk.
- [ ] Cross-run state is explicit and scoped by schedule ID; prior task history is not silently inherited.

## Important implementation facts beyond the public docs

These are confirmed in the installed ChatGPT desktop app `26.803.41515` (build `6321`), bundled `codex-cli 0.147.0-alpha.6.5`, not promised by current public docs:

- 30-second polling; maximum three due schedules per tick.
- Deterministic 0–119-second jitter on common recurring wall-clock schedules.
- Missed recurring instants collapse to one catch-up run.
- Same-schedule standalone runs may overlap.
- Delete does not cancel an already-started task.
- Startup archives orphan placeholders and moves real in-progress runs to pending review.
- Schedule cursor advances before run/task creation, leaving a small at-most-once crash window.
- Cross-run memory is a file next to the schedule definition.

Treat these as parity targets only if exact installed-app behavior is desired. A Zukhruf design may deliberately choose stronger guarantees—for example, a transactional occurrence outbox, explicit overlap policy, and first-class `FAILED`/`CANCELED` run states—without losing the essential Codex product model.

## Evidence locations

- Official: <https://learn.chatgpt.com/docs/automations>
- Official: <https://learn.chatgpt.com/docs/environments/git-worktrees>
- Installed app archive: `/Applications/ChatGPT.app/Contents/Resources/app.asar`
- Installed CLI: `/Applications/ChatGPT.app/Contents/Resources/codex`
- Installed schedule definitions: `$CODEX_HOME/automations/<id>/automation.toml`
- Installed cross-run memory: `$CODEX_HOME/automations/<id>/memory.md`
- Analysis-only extraction used for symbol names and line-oriented inspection: `/tmp/codex-asar-research/` (disposable; not a repository artifact)

Installed artifact hashes for reproducibility:

- `app.asar`: `5f6e773aafd542d3cf09e10b5dca6cabd301d0a155f4b8ce870e3915fc3da25e`
- `codex`: `e4432c0c085e4a2e5b9cf982e4dd2ebdb44ed33c422827b6e6c64353778e773b`
