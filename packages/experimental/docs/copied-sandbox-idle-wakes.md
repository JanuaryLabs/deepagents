# Copied: the sandbox idle wakes

Three parts of the sandbox idle stop exist in two places only. Under the Rule of
Three each stays copied until a third place needs it. Until then, mirror every
fix in both copies and name their files in the commit.

| Code                                           | Copies                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The `${turnQueue}-sandbox-idle` wake scheduler | `src/zukhruf/storage/embedded-agent-storage.ts`, `src/zukhruf/storage/postgres-agent-storage.ts`                    |
| A wake's id and its check on delivery          | `src/zukhruf/plugins/conversation-scheduling/conversation-scheduler.ts`, `src/zukhruf/runtime/sandbox-idle-stop.ts` |
| An outboxed pg-boss job and its relay          | `src/zukhruf/storage/turn-outbox.ts` (settle intent rows, wake rows)                                                |

## The `${turnQueue}-sandbox-idle` wake scheduler

- Same: right after the turn queue, both run

  ```ts
  const sandboxIdleWakes = new PgBossWakeScheduler<SandboxIdleWake>(boss, {
    queue: `${turnQueue.queue}-sandbox-idle`,
    pollingIntervalSeconds: 0.5,
  });
  await sandboxIdleWakes.initialize();
  ```

  The queue is named from the turn queue so that each distinct runtime gets its
  own idle wakes, and 0.5 s is pg-boss's minimum poll (the #5132 S3 step 0
  probe: a wake is delivered up to one poll late).

- Differs: the embedded storage owns its pg-boss; the Postgres storage borrows
  the host's. Neither disposes the scheduler, which holds nothing of its own.
  The embedded storage keeps the queue's name in `sandboxIdleQueue`, since its
  outbox sends archive stops to it too.

## A wake's id and its check on delivery

- Same: the wake's id and due time are

  ```ts
  const id = uuidv5(
    JSON.stringify([kind, ...keyFields, scheduledFor]),
    conversationNamespace(conversation),
  );
  const runAt = new Date(scheduledFor);
  ```

  so arming the same wake twice is a no-op and a new due time is a new wake.
  On delivery, the handler parses the payload with a strict schema and throws
  when the id does not match it. It does not compare `runAt` with
  `scheduledFor`: pg-boss moves a failed job's `start_after` to its retry time,
  so that check refused every retry (#5135 step 9).

- Differs: the key fields. A scheduling wake keys on its kind, definition id
  and generation (`ConversationScheduler.#wakeId`); an idle wake keys on the
  chat's `turnId` (`SandboxIdleStop.#wakeId`).

## An outboxed pg-boss job and its relay

- Same: the embedded storage commits the job in SQLite inside the admission,
  in a table of its own (`zukhruf_settle_outbox`, `zukhruf_wake_outbox`) with
  the columns `job_id UNIQUE, queue, chat_id, user_id` and its payload as JSON;
  `add…` inserts with `ON CONFLICT (job_id) DO NOTHING`, `oldest…` reads the
  row of the lowest `sequence`, and `OutboxRelay.drain` sends each row as its
  `job_id` and deletes it only after the send. `removeConversation` clears both.
- Differs: a wake row also keeps `run_at`, which the relay passes to
  `sendAfter`; a settle intent is due at once and goes through `send`.
