import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
} from '@deepagents/context';

import type { AgentDeclaration } from '../agent.ts';
import {
  AgentControlPlane,
  type TurnInput,
} from '../control-plane/agent-control-plane.ts';
import { AgentDeclarationRegistry } from '../control-plane/agent-declaration-registry.ts';
import { AgentDirectory } from '../control-plane/agent-directory.ts';
import { AgentHistoryForker } from '../control-plane/agent-history-forker.ts';
import { AgentStatusProjector } from '../control-plane/agent-status-projector.ts';
import { AgentTurnId } from '../control-plane/agent-turn-id.ts';
import { MailboxCoordinator } from '../mailbox/coordinator.ts';
import type { MailboxStore } from '../mailbox/store.ts';
import type {
  ConversationId,
  InterAgentCommunication,
  MessageDeliveryMode,
} from '../mailbox/types.ts';
import {
  type MultiAgentHostConfig,
  resolveMultiAgentHostConfig,
} from '../multi-agent-config.ts';
import type { TurnQueue, TurnRef } from '../queue/turn-queue.ts';
import {
  SchedulingCoordinator,
  type SchedulingWake,
} from '../scheduling/coordinator.ts';
import { createSchedulingTools } from '../scheduling/tools.ts';
import type { WakeScheduler } from '../scheduling/wake-scheduler.ts';
import { AgentTurnExecutor } from './agent-turn-executor.ts';
import { ApprovalController } from './approval-controller.ts';

export interface AgentRuntimeOptions {
  store: ContextStore;
  /** Borrowed stream subsystem; the caller owns its store, change source, and lifecycle. */
  streams: StreamManager;
  queue: TurnQueue;
  /** Durable pending inter-agent input. Distinct from the TurnQueue scheduler. */
  mailboxStore: MailboxStore;
  /** Codex-compatible multi-agent host guidance and tool configuration. */
  multiAgent?: MultiAgentHostConfig;
  scheduling?: {
    scheduler: WakeScheduler<SchedulingWake>;
    timezone: string;
  };
}

export interface AgentRuntimeWorkOptions {
  concurrency?: number;
}

export interface AgentRuntimeInfo {
  readonly root: string;
  readonly agents: readonly {
    readonly name: string;
    readonly model: {
      readonly provider: string;
      readonly modelId: string;
    };
    readonly tools: readonly string[];
    readonly subagents: readonly string[];
  }[];
}

/** Reconnect and cancellation view over one durable conversation. */
export class AgentObservation {
  readonly engine: ContextEngine;
  readonly #conversation: ConversationId;
  readonly #store: ContextStore;
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #scheduling?: SchedulingCoordinator;

  constructor(
    conversation: ConversationId,
    store: ContextStore,
    streams: StreamManager,
    queue: TurnQueue,
    scheduling?: SchedulingCoordinator,
  ) {
    this.engine = new ContextEngine({
      store,
      chatId: conversation.chatId,
      userId: conversation.userId,
    });
    this.#conversation = conversation;
    this.#store = store;
    this.#streams = streams;
    this.#queue = queue;
    this.#scheduling = scheduling;
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
    if (status === 'queued' || status === 'running' || status === 'cancelled') {
      await this.#streams.cancel(id);
      await this.#queue.cancel(id);
      await this.#scheduling?.materializeDueIfEligible(this.#conversation);
    }
  }

  async #headStreamId(): Promise<string | undefined> {
    const scheduled = await this.#queue.getCurrentTurn(this.#conversation);
    if (scheduled) return scheduled.streamId;

    const chat = await this.#store.getChat(this.#conversation.chatId);
    if (!chat) return undefined;
    if (chat.userId !== this.#conversation.userId) {
      throw new Error(
        `chat "${this.#conversation.chatId}" belongs to user "${chat.userId}", not "${this.#conversation.userId}"`,
      );
    }
    const head = await this.engine.headMessage();
    return head?.name === 'assistant' ? head.id : undefined;
  }
}

/** Thin host-facing composition and lifecycle façade for a Zukhruf agent tree. */
export class AgentRuntime {
  readonly info: AgentRuntimeInfo;

  readonly #store: ContextStore;
  readonly #queue: TurnQueue;
  readonly #streams: StreamManager;
  readonly #mailbox: MailboxCoordinator;
  readonly #directory: AgentDirectory;
  readonly #controlPlane: AgentControlPlane;
  readonly #approvals: ApprovalController;
  readonly #executor: AgentTurnExecutor;
  readonly #scheduling?: SchedulingCoordinator;

  constructor(root: AgentDeclaration, options: AgentRuntimeOptions) {
    const multiAgent = resolveMultiAgentHostConfig(options.multiAgent);
    const declarations = new AgentDeclarationRegistry(root);
    const directory = new AgentDirectory(options.store);
    const streams = options.streams;
    const mailbox = new MailboxCoordinator({
      store: options.mailboxStore,
      queue: options.queue,
      streams,
    });
    const approvals = new ApprovalController({
      store: options.store,
      queue: options.queue,
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
    const scheduling = options.scheduling
      ? new SchedulingCoordinator({
          store: options.store,
          scheduler: options.scheduling.scheduler,
          controlPlane,
          canMaterialize: async (conversation) =>
            (await options.queue.getTurnActivity(conversation)) === 'idle' &&
            !(await approvals.isConversationPaused(conversation)),
          timezone: options.scheduling.timezone,
        })
      : undefined;

    this.#store = options.store;
    this.#queue = options.queue;
    this.#streams = streams;
    this.#mailbox = mailbox;
    this.#directory = directory;
    this.#controlPlane = controlPlane;
    this.#approvals = approvals;
    this.#scheduling = scheduling;
    this.info = {
      root: declarations.root.name,
      agents: Array.from(declarations.values(), (declaration) => ({
        name: declaration.name,
        model: {
          provider: declaration.model.provider,
          modelId: declaration.model.modelId,
        },
        tools: Object.keys(declaration.tools ?? {}).sort(),
        subagents: (declaration.subagents ?? []).map(({ name }) => name),
      })),
    };
    this.#executor = new AgentTurnExecutor({
      store: options.store,
      streams,
      controlPlane,
      mailbox,
      approvals,
      multiAgent,
      schedulingTools:
        scheduling === undefined
          ? {}
          : createSchedulingTools(scheduling, multiAgent.toolNamespace),
    });
  }

  async createSession(conversation: ConversationId): Promise<void> {
    await this.#controlPlane.resolve(conversation);
  }

  async sessionExists(conversation: ConversationId): Promise<boolean> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat || chat.userId !== conversation.userId) return false;
    return (await this.#directory.load(conversation))?.path.isRoot ?? false;
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
    return new AgentObservation(
      conversation,
      this.#store,
      this.#streams,
      this.#queue,
      this.#scheduling,
    );
  }

  async work(options?: AgentRuntimeWorkOptions): Promise<AsyncDisposable> {
    const scheduling = this.#scheduling;
    const workers = new AsyncDisposableStack();
    workers.use(
      await this.#queue.consume(this.#executor.execute.bind(this.#executor), {
        concurrency: options?.concurrency,
        onOrphaned: this.#onOrphaned.bind(this),
        onSettled:
          scheduling === undefined
            ? undefined
            : ({ chatId, userId }) =>
                scheduling.materializeDueIfEligible({ chatId, userId }),
      }),
    );
    try {
      if (scheduling) workers.use(await scheduling.work());
      return workers;
    } catch (error) {
      await workers.disposeAsync();
      throw error;
    }
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
        (turn.kind === 'approval' ||
          (turn.kind === 'continuation' && turn.recovery !== 'idempotent')) &&
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
      if (
        (turn.kind === 'approval' || turn.kind === 'continuation') &&
        stream?.status === 'completed' &&
        (await this.#approvals.recoverUnstartedContinuation(
          turn,
          turn.streamId,
        ))
      ) {
        return;
      }
      stream = await this.#streams.store.getStream(turn.streamId);
      if (
        (turn.kind === 'approval' || turn.kind === 'continuation') &&
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
        if (turn.kind === 'approval' || turn.kind === 'continuation') {
          await this.#queue.resumeParked(turn.chatId);
        }
      } finally {
        await this.#mailbox.endTurn(turn);
      }
    }
  }
}
