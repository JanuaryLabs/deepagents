# Copied: the sandbox idle-wake scheduler of a storage

Each storage builds the scheduler of its chats' idle-stop wakes beside its
turn queue. Under the Rule of Three the construction stays copied until a third
storage needs it. Until then, mirror every fix in both files and name both
files in the commit.

| Code                                           | Copies                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The `${turnQueue}-sandbox-idle` wake scheduler | `src/zukhruf/storage/embedded-agent-storage.ts`, `src/zukhruf/storage/postgres-agent-storage.ts` |

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
