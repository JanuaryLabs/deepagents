# Choose the schedules HTTP projection contract

Type: grilling
Status: resolved
Blocked by: 01

## Question

How should a definition-bound `schedulesHttp(scheduled)` projection expose the
read model and existing lifecycle operations through Zukhruf HTTP discovery,
including package ownership, capability and route names, authenticated owner
derivation, validation, idempotency, not-found isolation, conflict and lifecycle
errors, and optional absence without coupling schedules to the static DevTool
host?

## Answer

The projection belongs beside the capability it represents, exported as
`@deepagents/experimental/zukhruf/schedules/http`:

```ts
export function schedulesHttp(
  definition: AgentPluginDefinition<Schedules>,
): HttpProjection;
```

It reuses `projectHttp(definition, ...)` to resolve the runtime-owned
`ScheduleControl`. It contributes one authenticated capability named
`schedules` at `/schedules`; the static `devtool()` Hono app receives no live
controller, plugin definition, service locator, owner, or schedules option.
When the host omits `schedulesHttp(scheduled)` from `http(runtime, ...)`,
discovery omits the capability and DevTool hides Scheduled navigation.

All routes live below the advertised capability root, so the browser derives
every URL from `capabilities.schedules.href`:

| Method   | Relative route           | Result                              |
| -------- | ------------------------ | ----------------------------------- |
| `GET`    | `/tasks`                 | List retained tasks                 |
| `POST`   | `/tasks`                 | Idempotently create a task          |
| `GET`    | `/tasks/:taskId`         | Read one task                       |
| `PATCH`  | `/tasks/:taskId`         | Update editable definition fields   |
| `DELETE` | `/tasks/:taskId`         | Purge an archived inactive task     |
| `POST`   | `/tasks/:taskId/pause`   | Pause future occurrences            |
| `POST`   | `/tasks/:taskId/resume`  | Resume from now                     |
| `POST`   | `/tasks/:taskId/run`     | Start or recover one manual run     |
| `POST`   | `/tasks/:taskId/archive` | Archive future occurrences          |
| `GET`    | `/tasks/:taskId/runs`    | List retained runs for one task     |
| `GET`    | `/runs/inbox`            | List owner-wide pending-review runs |
| `GET`    | `/runs/:runId`           | Read one run                        |
| `POST`   | `/runs/:runId/cancel`    | Idempotently cancel an active run   |
| `POST`   | `/runs/:runId/review`    | Mark a terminal run reviewed        |

There is no first-release run-archive route. Task purge remains the explicit
destructive operation that removes its runs.

Every handler derives `ownerId` exclusively from `context.get('userId')` after
the existing Zukhruf HTTP authentication middleware. Owner IDs are absent from
request bodies, query strings, paths, and responses. Missing and foreign task
or run IDs return the same non-revealing `404` response.

Create and Run now require the existing `Idempotency-Key` header contract.
Create returns `200` because the current domain operation may return an existing
identical task without reporting whether it inserted; Run now returns `202`.
Reads and other successful mutations return `200`; purge returns `204`. Every
response, including errors, uses `Cache-Control: no-store`.

The adapter reuses the current HTTP `validate()` helper, strict Zod objects,
UUID validation for schedule-owned IDs, and the existing request body limit.
The boundary accepts only the fields in `ScheduledTaskView` and
`ScheduledRunView`: trimmed bounded name, prompt, recurrence, timezone, and a
normalized fresh or existing conversation target. Unknown fields are rejected.
The browser generates idempotency keys with `crypto.randomUUID()`.

The schedules domain exposes one small typed error with a stable category:

```ts
class ScheduledTasksError extends Error {
  readonly code: 'invalid-input' | 'not-found' | 'conflict';
  readonly resource: 'task' | 'run';
}
```

The projection maps `invalid-input` to `400`, `not-found` to the uniform `404`,
and lifecycle or idempotency `conflict` to `409`. Malformed HTTP inputs remain
`400`, unsupported media remains `415`, oversized bodies remain `413`, and
wrong methods remain `405` with `Allow`. Unexpected errors are rethrown rather
than converted into misleading domain responses.

The projection exports the browser-safe view types decided by
[Define the Scheduled Task and run read model](01-define-scheduled-task-run-read-model.md).
It never serializes owner IDs, task idempotency keys, generations, raw execution
configuration, raw external execution IDs, or unused title/summary fields.
