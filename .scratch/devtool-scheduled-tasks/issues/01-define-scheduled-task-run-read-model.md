# Define the Scheduled Task and run read model

Type: grilling
Status: resolved
Blocked by: none

## Question

What is the smallest transport-neutral schedule control and browser-safe read
model that supports the agreed core: task management, per-task history, an
owner-wide pending-review inbox, exact conversation and turn navigation,
scheduled provenance, and explicit review or cancellation without requiring
generated titles, summaries, memory, notifications, or file-managed-task
policy?

## Comments

- A Scheduled Run never auto-archives. Marking it reviewed changes only review
  state, and archiving its Scheduled Task changes only future scheduling. The
  retained run remains independently addressable until explicit task purge.

## Answer

The existing task and run records remain authoritative. The scheduler adds one
transport-neutral operation:

```ts
listPendingReview(ownerId: string): Promise<ScheduledRun<ExecutionConfig>[]>;
```

It returns every owner-scoped run whose `reviewStatus` is `pending_review`,
including completed, failed, and cancelled runs from active or archived tasks,
ordered by terminal recency (`finishedAt DESC, id`). Dispatching and running
runs remain visible only through per-task history. Opening a run or conversation
does not mutate review state; only `markReviewed()` removes it from the Inbox.
The existing `archiveRun()` package operation remains compatible, but the first
DevTool HTTP/UI surface does not expose it and nothing calls it automatically.

No scheduler schema change is required. Runs already snapshot the executed
prompt, target configuration, occurrence, trigger, lifecycle timestamps, error,
and external execution ID. Task name is read from the retained current task;
the run's prompt remains the immutable record of what executed. Archived tasks
are hidden from the default task list but remain available through an Archived
filter. Purging an archived task is the explicit operation that removes its
retained runs.

The browser projection exposes only these fields:

```ts
interface ScheduledTaskView {
  id: string;
  name: string;
  prompt: string;
  recurrence: string;
  timezone: string;
  target:
    | { kind: 'new-conversation' }
    | {
        kind: 'existing-conversation';
        chatId: string;
      };
  status: ScheduledTaskStatus;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

interface ScheduledRunView {
  id: string;
  taskId: string;
  trigger: 'scheduled' | 'manual';
  occurrenceAt: number;
  prompt: string;
  target: ScheduledTaskView['target'];
  status: ScheduledRunStatus;
  reviewStatus: ScheduledRunReviewStatus | null;
  conversation: { chatId: string; turnId: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
```

Owner IDs, task idempotency keys, generations, raw execution configuration,
raw external execution IDs, and unused title/summary fields do not cross the
browser boundary. The HTTP projection derives the conversation reference once
launch has returned an execution ID: fresh runs use `run.id` as `chatId`,
existing targets use their configured `chatId`, and the external execution ID
is the exact `turnId`. A dispatch-cancelled run legitimately has no conversation.

Scheduled-task launch uses the existing `TurnInput.message` seam to persist a
user-message ID and provenance without changing runtime APIs:

```ts
message: {
  id: runId,
  metadata: {
    zukhruf: {
      origin: 'scheduled-task',
      scheduledTask: { taskId, runId, trigger, occurrenceAt },
    },
  },
}
```

This deliberately distinguishes host-owned Scheduled Tasks from the existing
Conversation Schedule metadata while reusing the proven queued-message metadata
path.

## Implementation note

`TurnInput` changed while this map was open: it is now
`{ message: TurnMessage; trigger: TurnTrigger }`, carrying a complete
`UIMessage` whose `id` is the idempotency key. The decision above is unchanged —
provenance still rides the queued user message's `metadata` — only the shape
moved:

```ts
await host.enqueue(conversation, {
  message: {
    id: runId,
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
    metadata: {
      zukhruf: {
        origin: SCHEDULED_TASK_ORIGIN,
        scheduledTask: { taskId, runId, trigger, occurrenceAt },
      },
    },
  },
  trigger: 'submit-message',
});
```

`ScheduledExecutionAdapter.launch` therefore receives `taskId`, `trigger`, and
`occurrenceAt` alongside the existing `runId`, `ownerId`, `prompt`, and
`executionConfig`.
