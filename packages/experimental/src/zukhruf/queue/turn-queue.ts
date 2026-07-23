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
       * Recovery-only re-execution of an existing stream. Normal approval
       * responses resume directly inside their approval job.
       */
      kind: 'continuation';
      recovery?: 'handoff' | 'idempotent';
    }
  | {
      kind: 'approval';
      toolCallId: string;
      approvalId: string;
      decision: { approved: true } | { approved: false; reason?: string };
    }
  | {
      /**
       * A mailbox wake-up. The communication payload remains in MailboxStore;
       * TurnQueue carries only the execution request and addressing.
       */
      kind: 'mailbox';
    }
);

export interface TurnPushResult {
  jobId: string;
  inserted: boolean;
}

export type ApprovalTurnRef = Extract<TurnRef, { kind: 'approval' }>;

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

export type TurnActivity = 'idle' | 'queued' | 'running';

/**
 * Durable holding pen for pending turns.
 *
 * Contract every implementation must honor:
 * - `push` is durable: a pushed turn survives process death until consumed.
 * - Delivery is AT-LEAST-ONCE: a pushed non-approval turn is delivered until settled, and
 *   duplicate pushes of the same `streamId` may each be delivered. Consumers
 *   MUST be idempotent on `streamId` (the zukhruf runtime skips turns whose
 *   stream row is terminal — a check that, unlike queue-side dedup, never
 *   expires with job retention).
 * - Approval pushes use their persisted approval id as a deterministic job
 *   identity. The first decision inserts; later decisions for that approval
 *   report the existing job instead of adding a row.
 * - Per chat, at most ONE handler invocation is active at a time, and turns
 *   run in the order they were pushed (strict FIFO per `chatId`) — this
 *   covers duplicates too: they can never run concurrently or out of order.
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
 *   and approval/recovery turns pushed for the chat outrank them.
 *
 * On platforms with native per-conversation serialization (e.g. Durable
 * Objects) this port is absorbed by the host rather than implemented.
 */
export abstract class TurnQueue {
  abstract push(turn: TurnRef): Promise<TurnPushResult>;

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
