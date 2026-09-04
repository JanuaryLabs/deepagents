import type { ConversationId } from '../../mailbox/types.ts';
import {
  type ConsumeContext,
  type ConsumeOptions,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
} from '../../queue/turn-queue.ts';

/**
 * Publishes the target conversation's status after every durable push.
 *
 * `push` is the single seam every queued turn crosses — host asks, spawned
 * children, mailbox wakes, and approval recovery — so decorating it here keeps
 * the "queued" transition visible without touching each producer.
 */
export class StatusPublishingTurnQueue extends TurnQueue {
  readonly #inner: TurnQueue;
  readonly #publish: (conversation: ConversationId) => Promise<void>;

  constructor(
    inner: TurnQueue,
    publish: (conversation: ConversationId) => Promise<void>,
  ) {
    super();
    this.#inner = inner;
    this.#publish = publish;
  }

  override async push(turn: TurnRef): Promise<void> {
    await this.#inner.push(turn);
    await this.#publish({ chatId: turn.chatId, userId: turn.userId });
  }

  override getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnActivity> {
    return this.#inner.getTurnActivity(conversation);
  }

  override getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnRef | undefined> {
    return this.#inner.getCurrentTurn(conversation);
  }

  override cancel(streamId: string): Promise<void> {
    return this.#inner.cancel(streamId);
  }

  override consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    return this.#inner.consume(handler, options);
  }

  override resumeParked(chatId: string): Promise<void> {
    return this.#inner.resumeParked(chatId);
  }
}
