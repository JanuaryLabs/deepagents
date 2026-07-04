export type TurnRef = {
  streamId: string;
  chatId: string;
  userId: string;
} & (
  | {
      kind: 'ask';
      /**
       * The user message, carried by the queue until the turn executes. It
       * enters the context chain only when the turn RUNS — enqueue-time
       * persistence would let a queued turn's message leak into the running
       * turn's prompt (and `chat()` streams into the chain head, which must
       * be THIS turn's placeholder).
       */
      input: string;
    }
  | {
      /**
       * Re-execution of an existing (reopened) stream after a tool approval
       * or denial. Carries no payload: the chain was already updated in
       * place by `approve()`/`deny()`.
       */
      kind: 'continuation';
    }
);

export interface ConsumeContext {
  signal: AbortSignal;
  /**
   * Park the turn being handled: it settles WITHOUT executing and is not
   * delivered again until `resumeParked(chatId)`. Used by the queue-behind
   * gate — turns arriving while their chat awaits a tool approval.
   */
  park: () => Promise<void>;
}

export interface ConsumeOptions {
  /** Max turns processed concurrently by this consumer (across chats). */
  concurrency?: number;
  /**
   * Fires for a turn whose handler crashed or whose worker died mid-turn.
   * After it resolves, the turn's chat is unblocked and its next queued
   * turn becomes eligible.
   */
  onOrphaned: (turn: TurnRef, error: string) => Promise<void>;
}

/**
 * Durable holding pen for pending turns.
 *
 * Contract every implementation must honor:
 * - `push` is durable: a pushed turn survives process death until consumed.
 * - Delivery is AT-LEAST-ONCE: a pushed turn is delivered until settled, and
 *   duplicate pushes of the same `streamId` may each be delivered. Consumers
 *   MUST be idempotent on `streamId` (the zukhruf runtime skips turns whose
 *   stream row is terminal — a check that, unlike queue-side dedup, never
 *   expires with job retention).
 * - Per chat, at most ONE handler invocation is active at a time, and turns
 *   run in the order they were pushed (strict FIFO per `chatId`) — this
 *   covers duplicates too: they can never run concurrently or out of order.
 * - Turns from different chats may run concurrently.
 * - A handler that throws (or a worker that dies mid-turn) does not retry:
 *   the turn surfaces once through `onOrphaned`, then the chat unblocks.
 * - A parked turn (`context.park()`) is not delivered again until
 *   `resumeParked(chatId)`; revived turns keep their original FIFO order,
 *   and a `'continuation'` turn pushed for the chat outranks them.
 *
 * On platforms with native per-conversation serialization (e.g. Durable
 * Objects) this port is absorbed by the host rather than implemented.
 */
export abstract class TurnQueue {
  abstract push(turn: TurnRef): Promise<void>;

  abstract consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable>;

  abstract resumeParked(chatId: string): Promise<void>;
}
