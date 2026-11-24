import type {
  SettleIntent,
  SettleQueue,
  TransactionalSettleIntents,
} from '@deepagents/experimental/zukhruf';

/** The first try and the 20 retries a storage's settle queue gives one intent. */
const ATTEMPTS = 21;

interface PendingIntent {
  followUp: string;
  intent: SettleIntent;
  attempts: number;
}

/**
 * Holds settle intents until a test drains them, so the test decides when
 * follow-ups run. An intent whose handler throws is tried again, up to the
 * attempts a storage's queue gives it, and then kept in `failed`, as a
 * failed pg-boss job stays. Recording an intent the queues already hold adds
 * nothing.
 */
export class ControlledSettleQueues implements TransactionalSettleIntents {
  readonly failed: { followUp: string; intent: SettleIntent }[] = [];
  readonly #pending = new Map<string, PendingIntent>();
  readonly #handlers = new Map<
    string,
    (intent: SettleIntent) => Promise<void>
  >();

  async record(
    followUp: string,
    id: string,
    intent: SettleIntent,
  ): Promise<void> {
    if (!this.#pending.has(id)) {
      this.#pending.set(id, { followUp, intent, attempts: 0 });
    }
  }

  queue(followUp: string): SettleQueue {
    return {
      consume: async (handler) => {
        this.#handlers.set(followUp, handler);
        return {
          [Symbol.asyncDispose]: async () => {
            this.#handlers.delete(followUp);
          },
        };
      },
    };
  }

  /** Runs every intent held, and every one they record, until each is done or has used its attempts. */
  async drain(): Promise<void> {
    for (;;) {
      const next = this.#pending
        .entries()
        .find(([, { followUp }]) => this.#handlers.has(followUp));
      if (!next) return;
      const [id, pending] = next;
      const handler = this.#handlers.get(pending.followUp);
      if (!handler) return;
      try {
        await handler(pending.intent);
        this.#pending.delete(id);
      } catch {
        pending.attempts++;
        if (pending.attempts >= ATTEMPTS) {
          this.#pending.delete(id);
          this.failed.push({
            followUp: pending.followUp,
            intent: pending.intent,
          });
        }
      }
    }
  }
}
