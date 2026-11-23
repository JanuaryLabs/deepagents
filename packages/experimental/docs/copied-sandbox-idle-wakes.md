# Copied: the sandbox idle wakes

Two parts of the sandbox idle stop exist in two places only. Under the Rule of
Three each stays copied until a third place needs it. Until then, mirror every
fix in both files and name both files in the commit.

| Code                                           | Copies                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The `${turnQueue}-sandbox-idle` wake scheduler | `src/zukhruf/storage/embedded-agent-storage.ts`, `src/zukhruf/storage/postgres-agent-storage.ts`                    |
| A wake's id and its check on delivery          | `src/zukhruf/plugins/conversation-scheduling/conversation-scheduler.ts`, `src/zukhruf/runtime/sandbox-idle-stop.ts` |

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
  when `runAt` or the id does not match it.

- Differs: the key fields. A scheduling wake keys on its kind, definition id
  and generation (`ConversationScheduler.#wakeId`); an idle wake keys on the
  chat's `turnId` (`SandboxIdleStop.#wakeId`).
