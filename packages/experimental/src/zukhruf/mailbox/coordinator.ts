import { setTimeout as delay } from 'node:timers/promises';

import type { StreamManager } from '@deepagents/context';

import { AgentTurnId } from '../control-plane/agent-turn-id.ts';
import type { TurnQueue, TurnRef } from '../queue/turn-queue.ts';
import type { MailboxStore } from './store.ts';
import {
  type ConversationId,
  MessageDeliveryMode as DeliveryMode,
  type InterAgentCommunication,
  InterAgentCommunicationType,
  type MessageDeliveryMode,
  assertCommunication,
} from './types.ts';

export interface MailboxCoordinatorOptions {
  store: MailboxStore;
  queue: Pick<TurnQueue, 'push'>;
  streams: StreamManager;
}

const WAIT_POLL_INTERVAL_MS = 50;

/** Owns durable mail delivery and the serialized turns that wake recipients. */
export class MailboxCoordinator {
  readonly #store: MailboxStore;
  readonly #queue: Pick<TurnQueue, 'push'>;
  readonly #streams: StreamManager;
  readonly #wakeRequests = new Map<string, Promise<void>>();

  constructor(options: MailboxCoordinatorOptions) {
    this.#store = options.store;
    this.#queue = options.queue;
    this.#streams = options.streams;
  }

  async deliver(
    communication: InterAgentCommunication,
    mode: MessageDeliveryMode,
  ): Promise<void> {
    const delivered = {
      ...communication,
      type:
        mode === DeliveryMode.TriggerTurn
          ? InterAgentCommunicationType.NewTask
          : communication.type,
      triggerTurn: mode === DeliveryMode.TriggerTurn,
    };
    assertCommunication(delivered);

    const { recipientActive } = await this.#store.enqueue(delivered);
    if (delivered.triggerTurn || recipientActive) {
      // Queue-only mail sent during an active turn gets a serialized fallback
      // in case sampling has already crossed its final safe drain boundary.
      await this.#scheduleWake(delivered.recipient);
    }
  }

  beginTurn(turn: TurnRef): Promise<void> {
    return this.#store.beginTurn(turn, turn.streamId);
  }

  async endTurn(
    turn: TurnRef,
    options: { parked?: boolean } = {},
  ): Promise<void> {
    const { hasPending, turnEnded } = await this.#store.endTurn(
      turn,
      turn.streamId,
    );
    if (turnEnded && hasPending && !options.parked) {
      await this.#scheduleWake(turn);
    }
  }

  drainLeadingQueueOnly(
    recipient: ConversationId,
  ): Promise<InterAgentCommunication[]> {
    return this.#store.drainLeadingQueueOnly(recipient);
  }

  drain(recipient: ConversationId): Promise<InterAgentCommunication[]> {
    return this.#store.drain(recipient);
  }

  async waitForPending(
    recipient: ConversationId,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<boolean> {
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      options.signal?.throwIfAborted();
      if (await this.#store.hasPending(recipient)) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(WAIT_POLL_INTERVAL_MS, remaining), undefined, {
        signal: options.signal,
      });
    }
  }

  #scheduleWake(target: ConversationId): Promise<void> {
    const key = this.#conversationKey(target);
    const existing = this.#wakeRequests.get(key);
    if (existing) return existing;

    // This map coalesces only concurrent requests in this process. A fulfilled
    // request is removed because another process may consume the wake.
    const request = (async () => {
      const wakeId = AgentTurnId.random(target).toString();
      await this.#streams.register(wakeId);
      try {
        await this.#queue.push({
          kind: 'mailbox',
          streamId: wakeId,
          chatId: target.chatId,
          userId: target.userId,
        } satisfies TurnRef);
      } catch (error) {
        await this.#streams.store.updateStreamStatus(wakeId, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })();
    this.#wakeRequests.set(key, request);

    const clearRequest = () => {
      if (this.#wakeRequests.get(key) === request) {
        this.#wakeRequests.delete(key);
      }
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }

  #conversationKey(conversation: ConversationId): string {
    return JSON.stringify([conversation.chatId, conversation.userId]);
  }
}
