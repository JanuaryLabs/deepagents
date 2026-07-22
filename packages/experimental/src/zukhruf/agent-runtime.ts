import {
  ContextEngine,
  type ContextStore,
  PollingChangeSource,
  StreamManager,
  type StreamStore,
} from '@deepagents/context';

import { AgentControlPlane, type TurnInput } from './agent-control-plane.ts';
import { AgentDeclarationRegistry } from './agent-declaration-registry.ts';
import { AgentDirectory } from './agent-directory.ts';
import { AgentHistoryForker } from './agent-history-forker.ts';
import { AgentStatusProjector } from './agent-status-projector.ts';
import { AgentTurnExecutor } from './agent-turn-executor.ts';
import { AgentTurnId } from './agent-turn-id.ts';
import type { AgentDeclaration } from './agent.ts';
import { ApprovalController } from './approval-controller.ts';
import type { ApprovalMutex } from './approval-mutex.ts';
import { MailboxCoordinator } from './mailbox/coordinator.ts';
import type { MailboxStore } from './mailbox/store.ts';
import type {
  ConversationId,
  InterAgentCommunication,
  MessageDeliveryMode,
} from './mailbox/types.ts';
import {
  type MultiAgentV2HostConfig,
  resolveMultiAgentV2HostConfig,
} from './multi-agent-v2-config.ts';
import type { TurnQueue, TurnRef } from './queue/turn-queue.ts';

export interface AgentRuntimeOptions {
  store: ContextStore;
  streamStore: StreamStore;
  queue: TurnQueue;
  /** Durable pending inter-agent input. Distinct from the TurnQueue scheduler. */
  mailboxStore: MailboxStore;
  /** Cross-process serialization for assistant-message approval transitions. */
  approvalMutex: ApprovalMutex;
  /** Codex MultiAgentV2-compatible host guidance and tool configuration. */
  multiAgentV2?: MultiAgentV2HostConfig;
}

export interface AgentRuntimeWorkOptions {
  concurrency?: number;
}

/** Reconnect and cancellation view over one durable conversation. */
export class AgentObservation {
  readonly engine: ContextEngine;
  readonly #conversation: ConversationId;
  readonly #store: ContextStore;
  readonly #streams: StreamManager;

  constructor(
    conversation: ConversationId,
    store: ContextStore,
    streams: StreamManager,
  ) {
    this.engine = new ContextEngine({
      store,
      chatId: conversation.chatId,
      userId: conversation.userId,
    });
    this.#conversation = conversation;
    this.#store = store;
    this.#streams = streams;
  }

  async resume() {
    const id = await this.#headStreamId();
    if (!id) return null;
    AgentTurnId.assertOwner(this.#conversation, id);
    const status = await this.#streams.store.getStreamStatus(id);
    return status ? this.#streams.watch(id) : null;
  }

  async cancel(streamId?: string): Promise<void> {
    const chat = await this.#store.getChat(this.#conversation.chatId);
    if (chat && chat.userId !== this.#conversation.userId) {
      throw new Error(
        `chat "${this.#conversation.chatId}" belongs to user "${chat.userId}", not "${this.#conversation.userId}"`,
      );
    }
    const id = streamId ?? (await this.#headStreamId());
    if (!id) return;
    AgentTurnId.assertOwner(this.#conversation, id);
    const status = await this.#streams.store.getStreamStatus(id);
    if (status === 'queued' || status === 'running') {
      await this.#streams.cancel(id);
    }
  }

  async #headStreamId(): Promise<string | undefined> {
    const head = await this.engine.headMessage();
    return head?.name === 'assistant' ? head.id : undefined;
  }
}

/** Thin host-facing composition and lifecycle façade for a Zukhruf agent tree. */
export class AgentRuntime {
  readonly #store: ContextStore;
  readonly #queue: TurnQueue;
  readonly #streams: StreamManager;
  readonly #mailbox: MailboxCoordinator;
  readonly #directory: AgentDirectory;
  readonly #controlPlane: AgentControlPlane;
  readonly #approvals: ApprovalController;
  readonly #executor: AgentTurnExecutor;

  constructor(root: AgentDeclaration, options: AgentRuntimeOptions) {
    const multiAgentV2 = resolveMultiAgentV2HostConfig(options.multiAgentV2);
    const declarations = new AgentDeclarationRegistry(root);
    const directory = new AgentDirectory(options.store);
    const streams = new StreamManager({
      store: options.streamStore,
      changeSource: new PollingChangeSource({ reads: options.streamStore }),
    });
    const mailbox = new MailboxCoordinator({
      store: options.mailboxStore,
      queue: options.queue,
      streams,
    });
    const approvals = new ApprovalController({
      store: options.store,
      streams,
      queue: options.queue,
      mutex: options.approvalMutex,
    });
    const statusProjector = new AgentStatusProjector({
      store: options.store,
      streams,
      queue: options.queue,
      mailbox,
      directory,
      approvals,
    });
    const historyForker = new AgentHistoryForker(options.store);
    const controlPlane = new AgentControlPlane({
      root,
      streams,
      queue: options.queue,
      mailbox,
      declarations,
      directory,
      statusProjector,
      historyForker,
    });

    this.#store = options.store;
    this.#queue = options.queue;
    this.#streams = streams;
    this.#mailbox = mailbox;
    this.#directory = directory;
    this.#controlPlane = controlPlane;
    this.#approvals = approvals;
    this.#executor = new AgentTurnExecutor({
      store: options.store,
      streams,
      controlPlane,
      mailbox,
      approvals,
      multiAgentV2,
    });
  }

  async enqueue(conversation: ConversationId, turn: TurnInput) {
    const streamId = await this.#controlPlane.enqueue(conversation, turn);
    return { id: streamId, stream: this.#streams.watch(streamId) };
  }

  async deliver(
    communication: InterAgentCommunication,
    mode: MessageDeliveryMode,
  ): Promise<void> {
    await this.#directory.assertOwnerIfExists(communication.recipient);
    await this.#mailbox.deliver(communication, mode);
  }

  approve(conversation: ConversationId, input: { toolCallId: string }) {
    return this.#approvals.approve(conversation, input);
  }

  deny(
    conversation: ConversationId,
    input: { toolCallId: string; reason?: string },
  ) {
    return this.#approvals.deny(conversation, input);
  }

  observe(conversation: ConversationId): AgentObservation {
    return new AgentObservation(conversation, this.#store, this.#streams);
  }

  work(options?: AgentRuntimeWorkOptions): Promise<AsyncDisposable> {
    return this.#queue.consume(this.#executor.execute.bind(this.#executor), {
      concurrency: options?.concurrency,
      onOrphaned: this.#onOrphaned.bind(this),
    });
  }

  async #onOrphaned(turn: TurnRef, error: string): Promise<void> {
    try {
      let stream = await this.#streams.store.getStream(turn.streamId);
      const firstReconciliation =
        stream?.status === 'queued' || stream?.status === 'running';
      if (firstReconciliation) {
        await this.#streams.store.updateStreamStatus(turn.streamId, 'failed', {
          error,
        });
        stream = await this.#streams.store.getStream(turn.streamId);
      }
      let declaration: AgentDeclaration | undefined;
      if (
        turn.kind === 'continuation' &&
        turn.recoveryAttempt === undefined &&
        stream?.status === 'failed'
      ) {
        try {
          ({ declaration } = await this.#controlPlane.resolve(turn));
        } catch {
          // Default terminal reconciliation below remains the safe fallback.
        }
      }
      if (
        declaration !== undefined &&
        (await this.#approvals.retryIdempotentContinuation(
          turn,
          turn.streamId,
          declaration.tools ?? {},
        ))
      ) {
        return;
      }
      stream = await this.#streams.store.getStream(turn.streamId);
      if (
        turn.kind === 'continuation' &&
        (stream?.status === 'completed' ||
          stream?.status === 'failed' ||
          stream?.status === 'cancelled')
      ) {
        await this.#approvals.reconcileTerminalContinuation(
          turn,
          turn.streamId,
          stream.status,
          stream.error ?? error,
        );
      }
      const { thread } = await this.#controlPlane.resolve(turn);
      if (
        thread.lastTurnId === undefined ||
        thread.lastTurnId === turn.streamId
      ) {
        await this.#controlPlane.recordLatestTurnIfCurrent(
          turn,
          turn.streamId,
          thread.lastTurnId,
        );
      }
      await this.#controlPlane.projectTerminal(turn, thread);
    } finally {
      try {
        if (turn.kind === 'continuation') {
          await this.#queue.resumeParked(turn.chatId);
        }
      } finally {
        await this.#mailbox.endTurn(turn);
      }
    }
  }
}
