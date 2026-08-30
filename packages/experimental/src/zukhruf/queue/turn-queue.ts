import type { UIMessage } from 'ai';

import type { ClientToolSet } from '../tool.ts';

export type TurnRequest = {
  /** Client-declared tools available to the model and completed by that client. */
  tools?: ClientToolSet;
} & (
  | {
      message: UIMessage & { role: 'user' };
      trigger: 'submit-message' | 'regenerate-message';
    }
  | {
      message: UIMessage & { role: 'assistant' };
      trigger: 'submit-message';
    }
);

export type TurnRef = {
  streamId: string;
  chatId: string;
  userId: string;
} & (
  | ({
      kind: 'message';
      /**
       * The complete UI message, carried by the queue until the turn executes. It
       * enters the context chain only when the turn RUNS — enqueue-time
       * persistence would let a queued turn's message leak into the running
       * turn's prompt (and `chat()` streams into the chain head, which must
       * be THIS turn's placeholder).
       */
    } & TurnRequest)
  | {
      /**
       * Internal re-execution of an existing assistant stream after a worker
       * handoff or a proven-idempotent tool failure.
       */
      kind: 'recovery';
      mode: 'handoff' | 'idempotent';
    }
  | {
      /**
       * A mailbox wake-up. The communication payload remains in MailboxStore;
       * TurnQueue carries only the execution request and addressing.
       */
      kind: 'mailbox';
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
  /**
   * Runs after a non-parked turn releases its conversation's FIFO ownership.
   * Implementations report failures without rolling back the settled turn.
   */
  onSettled?: (turn: TurnRef) => Promise<void>;
}

export type TurnActivity = 'idle' | 'queued' | 'running';

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
 * - After a non-parked job releases its FIFO ownership, `consume` invokes the
 *   optional `onSettled` hook before considering that delivery complete.
 * - Turns from different chats may run concurrently.
 * - `getTurnActivity` distinguishes queued from active scheduler work for
 *   status inspection; adapters must not silently fall back to stale history.
 * - `getCurrentTurn` returns the active turn, or otherwise the oldest eligible
 *   queued turn, for exact interruption. `cancel` removes queued copies of that
 *   exact stream and signals an adapter-local active handler, but an active turn
 *   retains FIFO ownership until its handler exits. Cross-process handler abort
 *   is the runtime stream-control layer's responsibility.
 * - A handler that throws (or a worker that dies mid-turn) does not retry:
 *   the turn surfaces once through `onOrphaned`, then the chat unblocks.
 * - Mailbox payloads NEVER live here. A `{kind: 'mailbox'}` item is only a
 *   durable wake request; the target MailboxStore remains the pending-input
 *   authority.
 * - A parked turn (`context.park()`) is not delivered again until
 *   `resumeParked(chatId)`; revived turns keep their original FIFO order,
 *   and recovery turns pushed for the chat outrank them.
 *
 * On platforms with native per-conversation serialization (e.g. Durable
 * Objects) this port is absorbed by the host rather than implemented.
 */
export abstract class TurnQueue {
  abstract push(turn: TurnRef): Promise<void>;

  /** Whether this conversation currently has queued or active scheduler work. */
  abstract getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnActivity>;

  /** Active turn, or the oldest eligible queued turn, for a conversation. */
  abstract getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnRef | undefined>;

  /** Cancel queued copies and request local active cancellation by stream id. */
  abstract cancel(streamId: string): Promise<void>;

  abstract consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable>;

  abstract resumeParked(chatId: string): Promise<void>;
}
