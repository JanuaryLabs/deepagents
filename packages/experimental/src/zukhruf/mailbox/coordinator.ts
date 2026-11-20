import { setTimeout as delay } from 'node:timers/promises';
import pMemoize from 'p-memoize';

import type {
  Admission,
  AgentResidency,
} from '../control-plane/agent-residency.ts';
import { AgentThreadLimitError } from '../control-plane/agent-thread-limit-error.ts';
import { AgentTurnId } from '../control-plane/agent-turn-id.ts';
import type { TurnRef } from '../queue/turn-queue.ts';
import type { MailboxStore } from './store.ts';
import {
  type ConversationId,
  type InterAgentCommunication,
  InterAgentCommunicationTypes,
  type MessageDeliveryMode,
  MessageDeliveryModes,
  assertCommunication,
} from './types.ts';

export interface MailboxCoordinatorOptions {
  store: MailboxStore;
  residency: AgentResidency;
}

const WAIT_POLL_INTERVAL_MS = 50;

/** Owns durable mail delivery and the serialized turns that wake recipients. */
export class MailboxCoordinator {
  readonly #store: MailboxStore;
  readonly #residency: AgentResidency;

  constructor(options: MailboxCoordinatorOptions) {
    this.#store = options.store;
    this.#residency = options.residency;
  }

  /**
   * Writes the mail and, in the same admission, the wake it needs. Trigger
   * mail to a sub-agent with no resident slot rejects with
   * `AgentThreadLimitError` and writes nothing.
   */
  async deliver(
    communication: InterAgentCommunication,
    mode: MessageDeliveryMode,
  ): Promise<void> {
    const delivered = {
      ...communication,
      type:
        mode === MessageDeliveryModes.TriggerTurn
          ? InterAgentCommunicationTypes.NewTask
          : communication.type,
      triggerTurn: mode === MessageDeliveryModes.TriggerTurn,
    };
    assertCommunication(delivered);

    const { recipient } = delivered;
    await this.#residency.admit(recipient, async (admission) => {
      if (delivered.triggerTurn) {
        if (!(await admission.admits(recipient))) {
          throw new AgentThreadLimitError();
        }
        await admission.mailboxStore.enqueue(delivered);
        await MailboxCoordinator.#wake(admission, recipient);
        return;
      }
      const { recipientActive } =
        await admission.mailboxStore.enqueue(delivered);
      // Queue-only mail sent during an active turn gets a serialized fallback
      // in case sampling has already crossed its final safe drain boundary.
      // Codex queue-only mail starts no turn, so a recipient without a
      // resident slot gets none.
      if (recipientActive && (await admission.admits(recipient))) {
        await MailboxCoordinator.#wake(admission, recipient);
      }
    });
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
    const deadline = performance.now() + options.timeoutMs;
    while (true) {
      options.signal?.throwIfAborted();
      if (await this.#store.hasPending(recipient)) return true;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await delay(Math.min(WAIT_POLL_INTERVAL_MS, remaining), undefined, {
        signal: options.signal,
      });
    }
  }

  /**
   * Coalesces only concurrent wake requests in this process. A settled request
   * is not kept, because another process may consume the wake. A recipient
   * left with only queue-only mail and no resident slot gets no wake.
   */
  readonly #scheduleWake = pMemoize(
    (target: ConversationId): Promise<void> =>
      this.#residency.admit(target, async (admission) => {
        if (await admission.admits(target)) {
          await MailboxCoordinator.#wake(admission, target);
        }
      }),
    {
      cacheKey: ([target]) => JSON.stringify([target.chatId, target.userId]),
      cache: false,
    },
  );

  static async #wake(
    admission: Admission,
    target: ConversationId,
  ): Promise<void> {
    const wakeId = AgentTurnId.random(target).toString();
    await admission.registerStream(wakeId);
    await admission.queue.push({
      kind: 'mailbox',
      streamId: wakeId,
      chatId: target.chatId,
      userId: target.userId,
    } satisfies TurnRef);
  }
}
