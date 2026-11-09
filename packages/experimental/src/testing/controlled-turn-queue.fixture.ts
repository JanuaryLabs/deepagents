import assert from 'node:assert/strict';

import {
  type ConsumeContext,
  type ConsumeOptions,
  TurnQueue,
  type TurnRef,
} from '@deepagents/experimental/zukhruf';

export type TurnConsumer = {
  handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  options: ConsumeOptions;
};

/**
 * Holds turns until a test runs one, so the test decides when each turn
 * executes. Real queues differ in what follows a handler (settle, orphan,
 * park), and tests depend on that, so a subclass overrides `deliver` or `park`.
 */
export class ControlledTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  readonly #consumers = new Set<TurnConsumer>();

  override async push(turn: TurnRef) {
    this.turns.push(turn);
  }

  override async getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<'idle' | 'queued' | 'running'> {
    return this.turns.some(
      (turn) =>
        turn.chatId === conversation.chatId &&
        turn.userId === conversation.userId,
    )
      ? 'queued'
      : 'idle';
  }

  override async getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnRef | undefined> {
    return this.turns.find(
      (turn) =>
        turn.chatId === conversation.chatId &&
        turn.userId === conversation.userId,
    );
  }

  override async cancel(streamId: string): Promise<void> {
    const remaining = this.turns.filter((turn) => turn.streamId !== streamId);
    this.turns.splice(0, this.turns.length, ...remaining);
  }

  override async consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    const consumer = { handler, options };
    this.#consumers.add(consumer);
    return {
      [Symbol.asyncDispose]: async () => {
        this.#consumers.delete(consumer);
      },
    };
  }

  override async resumeParked(): Promise<void> {}

  async runNext(): Promise<void> {
    const turn = this.turns.shift();
    assert.ok(turn, 'expected a queued turn');
    await this.deliver(turn, this.consumer);
  }

  protected get consumer(): TurnConsumer {
    const [consumer] = this.#consumers;
    assert.ok(consumer, 'expected a running worker');
    return consumer;
  }

  protected async deliver(
    turn: TurnRef,
    consumer: TurnConsumer,
  ): Promise<void> {
    await consumer.handler(turn, {
      signal: new AbortController().signal,
      park: () => this.park(),
    });
  }

  protected async park(): Promise<void> {
    throw new Error('turn unexpectedly parked');
  }

  protected async orphan(
    turn: TurnRef,
    consumer: TurnConsumer,
    error: unknown,
  ): Promise<void> {
    await consumer.options.onOrphaned(
      turn,
      error instanceof Error ? error.message : String(error),
    );
  }
}
