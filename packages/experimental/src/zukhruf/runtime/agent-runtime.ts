import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  type StreamPart,
  type StreamStatus,
} from '@deepagents/context';

import type { AgentDeclaration } from '../agent.ts';
import { createCollaborationTools } from '../collaboration/collaboration-tools.ts';
import {
  AgentControlPlane,
  type TurnInput,
} from '../control-plane/agent-control-plane.ts';
import { AgentDeclarationRegistry } from '../control-plane/agent-declaration-registry.ts';
import { AgentDirectory } from '../control-plane/agent-directory.ts';
import { AgentHistoryForker } from '../control-plane/agent-history-forker.ts';
import { AgentStatusProjector } from '../control-plane/agent-status-projector.ts';
import { AgentThread } from '../control-plane/agent-thread.ts';
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
import type { ZukhrufToolSet } from '../tool.ts';
import { AgentTurnExecutor } from './agent-turn-executor.ts';
import { ApprovalController } from './approval-controller.ts';

export interface AgentPluginToolContext extends Readonly<
  Record<string, unknown>
> {
  readonly conversation: ConversationId;
  readonly streamId: string;
  readonly agentName: string;
  readonly agentPath: string;
}

export interface AgentPluginHost {
  readonly info: AgentRuntimeInfo;
  enqueue(
    conversation: ConversationId,
    turn: TurnInput,
  ): Promise<{ id: string; stream: ReadableStream<StreamPart> }>;
  conversationExists(conversation: ConversationId): Promise<boolean>;
  isConversationAvailable(conversation: ConversationId): Promise<boolean>;
  readConversationMetadata(
    conversation: ConversationId,
  ): Promise<Record<string, unknown> | undefined>;
  updateConversationMetadata(
    conversation: ConversationId,
    update: (
      metadata: Record<string, unknown> | undefined,
    ) => Record<string, unknown>,
  ): Promise<void>;
  listHistory(): Promise<readonly AgentHistoryItem[]>;
  observe(conversation: ConversationId): AgentObservation;
}

export interface AgentRuntimePlugin {
  readonly name: string;
  readonly tools?: ZukhrufToolSet;
  /** Static namespaced context merged into every model call made by this runtime. */
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  configure?(root: AgentDeclaration): AgentDeclaration;
  initialize?(host: AgentPluginHost): Promise<void>;
  work?(host: AgentPluginHost): Promise<AsyncDisposable>;
  conversationAvailable?(
    host: AgentPluginHost,
    conversation: ConversationId,
  ): Promise<void>;
}

export interface AgentRuntimeOptions {
  store: ContextStore;
  /** Borrowed stream subsystem; the caller owns its store, change source, and lifecycle. */
  streams: StreamManager;
  queue: TurnQueue;
  /** Durable pending inter-agent input. Distinct from the TurnQueue scheduler. */
  mailboxStore: MailboxStore;
  /** Codex-compatible multi-agent host guidance and tool configuration. */
  multiAgent?: MultiAgentHostConfig;
  plugins?: readonly AgentRuntimePlugin[];
}

export interface AgentRuntimeWorkOptions {
  concurrency?: number;
}

export interface AgentRuntimeInfo {
  readonly root: string;
  readonly agents: readonly {
    readonly name: string;
    readonly description?: string;
    readonly model: {
      readonly provider: string;
      readonly modelId: string;
    };
    readonly tools: readonly string[];
    readonly subagents: readonly string[];
  }[];
}

export interface AgentHistoryItem {
  readonly chatId: string;
  readonly userId: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly status: StreamStatus | 'idle';
}

export interface AgentTurnStatus {
  status: StreamStatus;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

/** Reconnect and cancellation view over one durable conversation. */
export class AgentObservation {
  readonly engine: ContextEngine;
  readonly #conversation: ConversationId;
  readonly #store: ContextStore;
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #conversationAvailable?: () => Promise<void>;

  constructor(
    conversation: ConversationId,
    store: ContextStore,
    streams: StreamManager,
    queue: TurnQueue,
    conversationAvailable?: () => Promise<void>,
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
    this.#conversationAvailable = conversationAvailable;
  }

  async resume() {
    const id = await this.#headStreamId();
    if (!id) return null;
    AgentTurnId.assertOwner(this.#conversation, id);
    const status = await this.#streams.store.getStreamStatus(id);
    return status ? this.#streams.watch(id) : null;
  }

  async status(streamId?: string): Promise<AgentTurnStatus | undefined> {
    await this.#assertOwner();
    const id = streamId ?? (await this.#headStreamId());
    if (!id) return undefined;
    AgentTurnId.assertOwner(this.#conversation, id);
    const stream = await this.#streams.store.getStream(id);
    if (!stream) return undefined;
    return {
      status: stream.status,
      startedAt: stream.startedAt,
      finishedAt: stream.finishedAt,
      error: stream.error,
    };
  }

  async cancel(streamId?: string): Promise<void> {
    await this.#assertOwner();
    const id = streamId ?? (await this.#headStreamId());
    if (!id) return;
    AgentTurnId.assertOwner(this.#conversation, id);
    const status = await this.#streams.store.getStreamStatus(id);
    if (status === 'queued' || status === 'running' || status === 'cancelled') {
      await this.#streams.cancel(id);
      await this.#queue.cancel(id);
      await this.#conversationAvailable?.();
    }
  }

  async #assertOwner(): Promise<void> {
    const chat = await this.#store.getChat(this.#conversation.chatId);
    if (chat && chat.userId !== this.#conversation.userId) {
      throw new Error(
        `chat "${this.#conversation.chatId}" belongs to user "${chat.userId}", not "${this.#conversation.userId}"`,
      );
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
  readonly #plugins: readonly AgentRuntimePlugin[];
  readonly #pluginTools: ZukhrufToolSet;
  readonly #pluginHost: AgentPluginHost;
  #initialization?: Promise<void>;

  constructor(root: AgentDeclaration, options: AgentRuntimeOptions) {
    const multiAgent = resolveMultiAgentHostConfig(options.multiAgent);
    let configuredRoot = root;
    const plugins = options.plugins ?? [];
    const pluginNames = new Set<string>();
    const pluginTools: ZukhrufToolSet = {};
    const collaborationTools = createCollaborationTools(multiAgent);
    const injectedTools = new Map<string, string>(
      Object.keys(collaborationTools).map((name) => [name, 'the runtime']),
    );
    if (multiAgent.codeMode) injectedTools.set('code_mode', 'the runtime');
    for (const plugin of plugins) {
      if (!plugin.name.trim()) {
        throw new Error('AgentRuntime: plugin name cannot be empty');
      }
      if (plugin.name !== plugin.name.trim()) {
        throw new Error(
          `AgentRuntime: plugin name "${plugin.name}" must not contain surrounding whitespace`,
        );
      }
      if (pluginNames.has(plugin.name)) {
        throw new Error(`AgentRuntime: duplicate plugin name "${plugin.name}"`);
      }
      pluginNames.add(plugin.name);
      for (const [name, tool] of Object.entries(plugin.tools ?? {})) {
        const owner = injectedTools.get(name);
        if (owner) {
          throw new Error(
            `AgentRuntime: plugin tool "${name}" from "${plugin.name}" conflicts with ${owner}`,
          );
        }
        injectedTools.set(name, `plugin "${plugin.name}"`);
        pluginTools[name] = tool;
      }
    }
    for (const plugin of plugins) {
      if (plugin.configure) configuredRoot = plugin.configure(configuredRoot);
    }
    const declarations = new AgentDeclarationRegistry(configuredRoot);
    for (const declaration of declarations.values()) {
      for (const name of Object.keys(declaration.tools ?? {})) {
        const owner = injectedTools.get(name);
        if (owner) {
          throw new Error(
            `AgentRuntime: tool "${name}" on agent "${declaration.name}" conflicts with ${owner}`,
          );
        }
      }
    }
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
      root: declarations.root,
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
    this.#plugins = plugins;
    this.#pluginTools = pluginTools;
    this.info = {
      root: declarations.root.name,
      agents: Array.from(declarations.values(), (declaration) => ({
        name: declaration.name,
        ...(declaration.description === undefined
          ? {}
          : { description: declaration.description }),
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
      collaborationTools,
      pluginTools,
      pluginRuntimeContext: Object.assign(
        {},
        ...plugins.map(({ runtimeContext }) => runtimeContext ?? {}),
      ),
    });
    this.#pluginHost = {
      info: this.info,
      enqueue: (conversation, turn) => this.enqueue(conversation, turn),
      conversationExists: async (conversation) =>
        Boolean(await this.#directory.load(conversation)),
      isConversationAvailable: (conversation) =>
        this.#isConversationAvailable(conversation),
      readConversationMetadata: (conversation) =>
        this.#readConversationMetadata(conversation),
      updateConversationMetadata: (conversation, update) =>
        this.#updateConversationMetadata(conversation, update),
      listHistory: () => this.listHistory(),
      observe: (conversation) => this.observe(conversation),
    };
  }

  initialize(): Promise<void> {
    if (!this.#initialization) this.#initialization = this.#initialize();
    return this.#initialization;
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
      () => this.#conversationAvailable(conversation),
    );
  }

  async #isConversationAvailable(
    conversation: ConversationId,
  ): Promise<boolean> {
    return (
      (await this.#queue.getTurnActivity(conversation)) === 'idle' &&
      !(await this.#approvals.isConversationPaused(conversation))
    );
  }

  async #readConversationMetadata(
    conversation: ConversationId,
  ): Promise<Record<string, unknown> | undefined> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat) throw new Error(`chat "${conversation.chatId}" not found`);
    if (chat.userId !== conversation.userId) {
      throw new Error(
        `chat "${conversation.chatId}" belongs to user "${chat.userId}", not "${conversation.userId}"`,
      );
    }
    return chat.metadata;
  }

  async #updateConversationMetadata(
    conversation: ConversationId,
    update: (
      metadata: Record<string, unknown> | undefined,
    ) => Record<string, unknown>,
  ): Promise<void> {
    await this.#store.updateChat(conversation.chatId, (chat) => {
      if (chat.userId !== conversation.userId) {
        throw new Error(
          `chat "${conversation.chatId}" belongs to user "${chat.userId}", not "${conversation.userId}"`,
        );
      }
      return { metadata: update(chat.metadata) };
    });
  }

  async listHistory(userId?: string): Promise<readonly AgentHistoryItem[]> {
    const chats = await this.#store.listChats();
    const roots = chats.flatMap((chat) => {
      if (userId !== undefined && chat.userId !== userId) return [];
      const conversation = { chatId: chat.id, userId: chat.userId };
      const thread = AgentThread.fromMetadata(conversation, chat.metadata);
      if (!thread) {
        if (AgentThread.hasReservedMetadata(chat.metadata)) {
          throw new Error(`invalid Zukhruf metadata for chat "${chat.id}"`);
        }
        return [];
      }
      return thread.path.isRoot && thread.declarationName === this.info.root
        ? [{ chat, thread }]
        : [];
    });

    return Promise.all(
      roots.map(async ({ chat, thread }) => {
        const stream = thread.lastTurnId
          ? await this.#streams.store.getStream(thread.lastTurnId)
          : undefined;
        return {
          chatId: chat.id,
          userId: chat.userId,
          ...(chat.title === undefined ? {} : { title: chat.title }),
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          messageCount: chat.messageCount,
          status: stream?.status ?? 'idle',
        };
      }),
    );
  }

  async work(options?: AgentRuntimeWorkOptions): Promise<AsyncDisposable> {
    await this.initialize();
    const workers = new AsyncDisposableStack();
    try {
      for (const plugin of this.#plugins) {
        if (plugin.work) workers.use(await plugin.work(this.#pluginHost));
      }
      workers.use(
        await this.#queue.consume(this.#executor.execute.bind(this.#executor), {
          concurrency: options?.concurrency,
          onOrphaned: this.#onOrphaned.bind(this),
          onSettled: !this.#plugins.some(({ conversationAvailable }) =>
            Boolean(conversationAvailable),
          )
            ? undefined
            : ({ chatId, userId }) =>
                this.#conversationAvailable({ chatId, userId }),
        }),
      );
      return workers;
    } catch (error) {
      await workers.disposeAsync();
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    for (const plugin of this.#plugins) {
      await plugin.initialize?.(this.#pluginHost);
    }
  }

  async #conversationAvailable(conversation: ConversationId): Promise<void> {
    const errors: unknown[] = [];
    for (const plugin of this.#plugins) {
      try {
        await plugin.conversationAvailable?.(this.#pluginHost, conversation);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `AgentRuntime: conversation availability reconciliation failed for "${conversation.chatId}": ${errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')}`,
      );
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
          { ...declaration.tools, ...this.#pluginTools },
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
