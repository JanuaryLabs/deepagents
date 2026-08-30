# Choose implementation slices and acceptance gates

Type: grilling
Status: resolved
Blocked by: 02, 03, 04

## Question

What dependency-ordered implementation slices and public-boundary acceptance
evidence are sufficient to hand this map to coding work, covering scheduler read
model changes, HTTP projection, optional discovery, core UI, demo composition,
owner isolation, lifecycle and idempotency errors, exact conversation links,
browser routing and accessibility, restart durability, package exports, Nx
typecheck and test targets, and live browser verification?

## Answer

Status: resolved and implemented.

Five dependency-ordered slices, each verified before the next.

### Slice 1 — Scheduler read model

`listPendingReview(ownerId)` selects `review_status = 'pending_review'` ordered
`finished_at DESC, id`, backed by a matching partial index. `review_status` is
only written on a terminal transition, so no redundant status filter is needed.
`ScheduledTasksError` carries `code` (`invalid-input | not-found | conflict`)
and `resource` (`task | run`); internal invariants and worker-side faults stay
plain `Error` and are rethrown rather than mapped. `ScheduledExecutionAdapter.
launch` gains `taskId`, `trigger`, and `occurrenceAt` so the runtime adapter can
persist provenance.

### Slice 2 — HTTP projection

`schedulesHttp()` ships at `@deepagents/experimental/zukhruf/schedules/http`
with the ticket-02 routes, strict Zod bodies, UUID-checked schedule IDs,
`Idempotency-Key` on create and Run now, `Cache-Control: no-store` everywhere,
and one non-revealing `404`.

Two constraints were discovered here and must not regress:

1. **The projection may only type-import the domain.** `additionalEntryPoints`
   emits an independent esbuild bundle per entry, so a value import gave
   `http.js` its own `ScheduledTasksError` (plus the whole scheduler,
   `cron-parser`, and `rrule`); every `instanceof` check then failed and every
   domain rejection surfaced as `500`. The projection matches on `error.name`.
2. **Errors convert at the call site, not in middleware.** Hono's `compose()`
   wraps each handler in its own `try/catch` and, when the app defines
   `onError`, resolves the error at that innermost frame — an ancestor
   middleware's `await next()` never observes it. Every domain call is wrapped
   in `domain(...)`.

### Slice 3 — DevTool UI

Discovery gains an optional `schedules` capability; the sidebar entry renders
only when it is present. `app/schedules-data.ts` owns the queries and one
`useScheduleCommand` mutation so the workspace has a single error surface.
`routes/scheduled.tsx` implements the approved shape against real data.

### Slice 4 — Demo composition

See [Choose the DevTool schedules demo composition](04-choose-devtool-schedules-demo-composition.md).

### Slice 5 — Acceptance gates

Public-boundary integration coverage lives in
`packages/experimental/src/zukhruf/plugins/schedules/schedules-http.integration.test.ts`
and drives one real `AgentRuntime`, one real `ScheduledTasks` on PGlite and
pg-boss, and one real `http(runtime, schedulesHttp(scheduled))`:

- discovery advertises `schedules` only when composed; absent means `404`, and
  unauthenticated means `401`;
- create is idempotent, owner-scoped, and projects exactly the eleven
  `ScheduledTaskView` keys;
- foreign and missing IDs return byte-identical `404` bodies;
- purge before archive is `409`; an unknown target conversation is `400`;
- Run now returns `202`, is idempotent, and projects exactly the fourteen
  `ScheduledRunView` keys;
- the queued turn carries
  `metadata.zukhruf.{origin, scheduledTask}` and a fresh run's `chatId` equals
  its `run.id`, while an existing target keeps its own `chatId`;
- opening a run leaves `pending_review` intact, archiving its task leaves it in
  the inbox, review removes it from the inbox but not from task history, and
  purge removes the run.

Browser verification runs against `demo/zukhruf-schedules/server.ts`.
