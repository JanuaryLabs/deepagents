import type { Telemetry } from 'ai';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  type StreamPart,
  type StreamStatus,
} from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../agent.ts';
import { Team } from '../collaboration/team.ts';
import { AgentControlPlane } from '../control-plane/agent-control-plane.ts';
import { AgentDirectory } from '../control-plane/agent-directory.ts';
import { AgentResidency } from '../control-plane/agent-residency.ts';
import { AgentStatusProjector } from '../control-plane/agent-status-projector.ts';
import { AgentThread } from '../control-plane/agent-thread.ts';
import { AgentTurnId } from '../control-plane/agent-turn-id.ts';
import {
  ConversationNotFoundError,
  assertConversationOwner,
} from '../control-plane/conversation-not-found-error.ts';
import { MailboxCoordinator } from '../mailbox/coordinator.ts';
import type {
  ConversationId,
  InterAgentCommunication,
  MessageDeliveryMode,
} from '../mailbox/types.ts';
import type { TurnQueue, TurnRef, TurnRequest } from '../queue/turn-queue.ts';
import type { AgentStorage } from '../storage/agent-storage.ts';
import type { ZukhrufToolSet } from '../tool.ts';
import { AgentTurnExecutor } from './agent-turn-executor.ts';
import { ApprovalController } from './approval-controller.ts';
import { ConversationSandboxes } from './conversation-sandboxes.ts';
import type { ConversationStatusChangeSource } from './conversation-status/change-source.ts';
import type { ChildProgress } from './conversation-status/child-progress.ts';
import {
  type ConversationStatus,
  type ConversationStatusEvent,
  ConversationStatusProjector,
} from './conversation-status/projector.ts';
import { PluginManager } from './plugin/plugin-manager.ts';
import { SandboxIdleStop } from './sandbox-idle-stop.ts';

export interface AgentPluginToolContext extends Readonly<
  Record<string, unknown>
> {
  readonly conversation: ConversationId;
  /** Root conversation id of this agent tree, which is the session id per-conversation plugin state is scoped by. */
  readonly treeId: string;
  readonly streamId: string;
  readonly agentName: string;
  readonly agentPath: string;
}

export interface AgentPluginHost {
  readonly info: AgentRuntimeInfo;
  enqueue(
    conversation: ConversationId,
    turn: TurnRequest,
  ): Promise<{ id: string; stream: ReadableStream<StreamPart> }>;
  /**
   * Open the root agent's sandbox for `conversation`, or borrow the handle the
   * host already holds. The handle is borrowed: a plugin never closes it. The
   * environment names the sandbox from `chatId`, so every turn, worker and
   * restart reaches the same one (see `AgentDeclaration.sandbox` in
   * `agent.ts`), and this works before the conversation exists.
   */
  sandbox(conversation: ConversationId): Promise<ZukhrufSandbox>;
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
  /** Status changes observed by this process; ends when `signal` aborts. */
  subscribeConversationStatus(
    signal: AbortSignal,
  ): Promise<AsyncIterable<ConversationStatusEvent>>;
}

export interface AgentPluginBinding {
  readonly capability: AgentPluginCapability<unknown>;
  readonly value: unknown;
}

export class AgentPluginCapability<Value> {
  readonly name: string;
  /** Each value this capability bound, keyed by the binding that carries it. */
  readonly #bound = new WeakMap<
    AgentPluginBinding,
    { readonly value: Value }
  >();

  constructor(name: string) {
    this.name = name;
  }

  bind(value: Value): AgentPluginBinding {
    const binding: AgentPluginBinding = { capability: this, value };
    this.#bound.set(binding, { value });
    return binding;
  }

  /** Reads the value of a binding this capability created with `bind`. */
  read(binding: AgentPluginBinding): Value {
    const bound = this.#bound.get(binding);
    if (!bound) {
      throw new Error(
        `AgentRuntime: binding for capability "${this.name}" was not created by its bind()`,
      );
    }
    return bound.value;
  }
}

export interface AgentPluginBindings {
  get<Value>(capability: AgentPluginCapability<Value>): Value;
}

/**
 * A plugin's running phase: what `initialize(host)` builds once the host
 * exists, and what `AgentHost.plugin(definition)` returns.
 */
export interface AgentPluginInitialization extends Partial<AsyncDisposable> {
  readonly tools?: ZukhrufToolSet;
  /** Hosts wait for active plugin work before releasing infrastructure. */
  work?(): Promise<AsyncDisposable>;
  conversationAvailable?(conversation: ConversationId): Promise<void>;
}

/**
 * What a plugin contributes before the host exists, since `host.info` is built
 * from it, and the `initialize(host)` that builds its running phase.
 */
export interface AgentPluginInstance<Running extends object = object> {
  readonly tools?: ZukhrufToolSet;
  /** Per-turn AI SDK telemetry integration contributed by this plugin. */
  telemetry?(context: AgentPluginToolContext): Telemetry;
  /** Directories whose immediate Markdown files declare plugin-scoped agents. */
  readonly agents?: readonly (string | URL)[];
  /** Skill directories available for agents to select by frontmatter name. */
  readonly skills?: readonly (string | URL)[];
  /** Static namespaced context merged into every model call made by this runtime. */
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  configure?(root: AgentDeclaration): AgentDeclaration;
  initialize?(
    host: AgentPluginHost,
  ): Promise<void | (AgentPluginInitialization & Running)>;
}

export interface AgentPluginDefinition<Running extends object = object> {
  readonly name: string;
  readonly capabilities?: readonly AgentPluginCapability<unknown>[];
  create(bindings: AgentPluginBindings): AgentPluginInstance<Running>;
}

export interface AgentRuntimeWorkOptions {
  concurrency?: number;
}

export interface AgentRuntimeInfo {
  readonly root: string;
  readonly agents: readonly {
    readonly name: string;
    readonly description?: string;
    readonly plugin?: string;
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
  readonly status: ConversationStatus;
  readonly children?: readonly ChildProgress[];
}

export interface AgentTurnStatus {
  status: StreamStatus;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

interface AgentObservationStatus {
  read: () => Promise<ConversationStatus>;
  publish: () => Promise<void>;
}

/** Reconnect and cancellation view over one durable conversation. */
export class AgentObservation {
  readonly engine: ContextEngine;
  readonly #conversation: ConversationId;
  readonly #directory: AgentDirectory;
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #status: AgentObservationStatus;
  readonly #conversationAvailable?: () => Promise<void>;

  constructor(
    conversation: ConversationId,
    store: ContextStore,
    directory: AgentDirectory,
    streams: StreamManager,
    queue: TurnQueue,
    status: AgentObservationStatus,
    conversationAvailable?: () => Promise<void>,
  ) {
    this.engine = new ContextEngine({
      store,
      chatId: conversation.chatId,
      userId: conversation.userId,
    });
    this.#conversation = conversation;
    this.#directory = directory;
    this.#streams = streams;
    this.#queue = queue;
    this.#status = status;
    this.#conversationAvailable = conversationAvailable;
  }

  /** Codex-shaped conversation status derived from durable state. */
  async conversationStatus(): Promise<ConversationStatus> {
    await this.#assertOwner();
    return this.#status.read();
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
      await this.#status.publish();
      await this.#conversationAvailable?.();
    }
  }

  async #assertOwner(): Promise<void> {
    await this.#directory.assertOwnerIfExists(this.#conversation);
  }

  async #headStreamId(): Promise<string | undefined> {
    const scheduled = await this.#queue.getCurrentTurn(this.#conversation);
    if (scheduled) return scheduled.streamId;

    return (await this.#directory.load(this.#conversation))?.lastTurnId;
  }
}

/** A reusable recipe. Register only resources the returned host should own. */
export type AgentStack = (resources: AsyncDisposableStack) => Promise<{
  /**
   * Conversations, streams, turns and mail on one database. The host
   * borrows it: register a storage the host should close on `resources`.
   */
  storage: AgentStorage;
  /** The collaboration tools and guidance every agent gets. Defaults to `Team.codex()`. */
  multiAgent?: Team;
  /** Host implementations for capabilities required by root-owned plugins. */
  bindings?: readonly AgentPluginBinding[];
  /**
   * Cross-process conversation status hints. Without it, status changes are
   * observed only by the process where the transition happened.
   */
  conversationStatusChanges?: ConversationStatusChangeSource;
}>;

/** Defines infrastructure without acquiring it; each initialization opens its own scope. */
export function defineStack(create: AgentStack): AgentStack {
  return create;
}

/** Ready operations and ownership, available only after initialize() succeeds. */
export type AgentHost = Omit<RuntimeHost, 'initialize'>;

/** Creates independent ready hosts from an agent declaration. */
export class AgentRuntime {
  readonly #root: AgentDeclaration;

  constructor(root: AgentDeclaration) {
    this.#root = root;
  }

  async initialize(stack: AgentStack): Promise<AgentHost> {
    const resources = new AsyncDisposableStack();
    try {
      const options = await stack(resources);
      const host = new RuntimeHost(this.#root, options, resources);
      await host.initialize();
      return host;
    } catch (error) {
      await using rollback = resources;
      throw error;
    }
  }
}

/** Compiles an initialized adapter set and supplies the plugin host. */
class RuntimeHost implements AsyncDisposable {
  readonly info: AgentRuntimeInfo;
  readonly #resources: AsyncDisposableStack;
  readonly #workers = new AsyncDisposableStack();

  readonly #store: ContextStore;
  readonly #queue: TurnQueue;
  readonly #streams: StreamManager;
  readonly #mailbox: MailboxCoordinator;
  readonly #directory: AgentDirectory;
  readonly #controlPlane: AgentControlPlane;
  readonly #approvals: ApprovalController;
  readonly #conversationStatus: ConversationStatusProjector;
  readonly #executor: AgentTurnExecutor;
  readonly #root: AgentDeclaration;
  readonly #plugins: PluginManager;
  readonly #pluginHost: AgentPluginHost;
  readonly #idleStop: SandboxIdleStop;

  constructor(
    root: AgentDeclaration,
    options: Awaited<ReturnType<AgentStack>>,
    resources: AsyncDisposableStack,
  ) {
    this.#resources = resources;
    const team = options.multiAgent ?? Team.codex();
    const plugins = resources.use(
      new PluginManager(root, options.bindings, team),
    );
    const declarations = plugins.declarations;
    const { storage } = options;
    const directory = new AgentDirectory(storage.store);
    const streams = storage.streams;
    const conversationStatus = new ConversationStatusProjector({
      store: storage.store,
      streams,
      queue: storage.queue,
      directory,
      changeSource: options.conversationStatusChanges,
    });
    const queue = storage.queue;
    // Every turn pushed to a conversation is admitted here, and publishes the
    // conversation's status once its admission commits.
    const residency = new AgentResidency({
      storage,
      directory,
      maxConcurrentThreadsPerSession: team.maxConcurrentThreads,
      publish: (conversation) => conversationStatus.publish(conversation),
    });
    const mailbox = new MailboxCoordinator({
      store: storage.mailboxStore,
      residency,
    });
    const approvals = new ApprovalController({
      store: storage.store,
      queue,
      residency,
    });
    const statusProjector = new AgentStatusProjector({
      store: storage.store,
      streams,
      queue,
      mailbox,
      directory,
      approvals,
    });
    const controlPlane = new AgentControlPlane({
      root: declarations.root,
      streams,
      queue,
      mailbox,
      declarations,
      directory,
      statusProjector,
      residency,
      recordActivity: (thread, activity) =>
        conversationStatus.recordActivity(thread, activity),
    });
    this.#store = storage.store;
    this.#queue = queue;
    this.#streams = streams;
    this.#mailbox = mailbox;
    this.#directory = directory;
    this.#controlPlane = controlPlane;
    this.#approvals = approvals;
    this.#conversationStatus = conversationStatus;
    this.#root = declarations.root;
    this.#plugins = plugins;
    this.info = {
      root: declarations.root.name,
      agents: Array.from(declarations.values(), (declaration) => ({
        name: declaration.name,
        ...(declaration.description === undefined
          ? {}
          : { description: declaration.description }),
        ...(plugins.agentOwners.has(declaration.name)
          ? { plugin: plugins.agentOwners.get(declaration.name) }
          : {}),
        model: {
          provider: declaration.model.provider,
          modelId: declaration.model.modelId,
        },
        tools: Object.keys(declaration.tools ?? {}).sort(),
        subagents: (declaration.subagents ?? []).map(({ name }) => name),
      })),
    };
    // Registered before the workers, so it is disposed after they stop.
    const sandboxes = resources.use(new ConversationSandboxes());
    this.#idleStop = new SandboxIdleStop({
      wakes: storage.sandboxIdleWakes,
      declarations,
      directory,
      streams: streams.store,
      residency,
      conversationStatus,
    });
    this.#executor = new AgentTurnExecutor({
      store: storage.store,
      streams,
      controlPlane,
      mailbox,
      approvals,
      team,
      plugins,
      sandboxes,
      publishConversationStatus: (conversation) =>
        conversationStatus.publish(conversation),
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
      subscribeConversationStatus: (signal) =>
        this.subscribeConversationStatus(signal),
      // Borrows the root declaration's sandbox directly: resolving the
      // conversation through the control plane would create its root thread.
      sandbox: async (conversation) => {
        await this.#directory.assertOwnerIfExists(conversation);
        return sandboxes.acquire(this.#root, {
          chatId: conversation.chatId,
          userId: conversation.userId,
        });
      },
    };
    resources.use(this.#workers);
  }

  initialize(): Promise<void> {
    return this.#plugins.initialize(this.#pluginHost);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#resources.disposeAsync();
  }

  /** The running phase `initialize(host)` returned for `definition`. */
  plugin<Running extends object>(
    definition: AgentPluginDefinition<Running>,
  ): AgentPluginInitialization & Running {
    return this.#plugins.get(definition);
  }

  /** Creates the root chat, or keeps a chat of a tree this runtime owns (its root or a sub-agent); any other chat reads as absent. */
  async createSession(conversation: ConversationId): Promise<void> {
    const thread =
      (await this.#directory.load(conversation)) ??
      (await this.#controlPlane.resolve(conversation)).thread;
    if (!(await this.#ownsTree(thread))) {
      throw new ConversationNotFoundError(conversation.chatId);
    }
  }

  async sessionExists(conversation: ConversationId): Promise<boolean> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat || chat.userId !== conversation.userId) return false;
    const thread = await this.#directory.load(conversation);
    return thread !== undefined && this.#ownsRoot(thread);
  }

  /** A root thread this runtime's root declaration started. */
  #ownsRoot(thread: AgentThread): boolean {
    return thread.path.isRoot && thread.declarationName === this.info.root;
  }

  /** A thread of a tree this runtime's root declaration started: that root, or a sub-agent under it. */
  async #ownsTree(thread: AgentThread): Promise<boolean> {
    if (thread.path.isRoot) return this.#ownsRoot(thread);
    const root = await this.#directory.load({
      chatId: thread.treeId,
      userId: thread.conversation.userId,
    });
    return root !== undefined && this.#ownsRoot(root);
  }

  async enqueue(conversation: ConversationId, turn: TurnRequest) {
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

  observe(conversation: ConversationId): AgentObservation {
    return new AgentObservation(
      conversation,
      this.#store,
      this.#directory,
      this.#streams,
      this.#queue,
      {
        read: () => this.#conversationStatus.read(conversation),
        publish: () => this.#conversationStatus.publish(conversation),
      },
      () => this.#plugins.conversationAvailable(conversation),
    );
  }

  /**
   * Conversation status changes observed by this process, in the shape of
   * Codex's `thread/status/changed`. Execution transitions are observed by the
   * process running `work()`; `observe(...).conversationStatus()` is always
   * authoritative.
   */
  subscribeConversationStatus(
    signal: AbortSignal,
  ): Promise<AsyncIterable<ConversationStatusEvent>> {
    return this.#conversationStatus.subscribe(signal);
  }

  /** Available unless its status is `active`: a failed latest turn is no reason to hold work back. */
  async #isConversationAvailable(
    conversation: ConversationId,
  ): Promise<boolean> {
    return (
      (await this.#conversationStatus.read(conversation)).type !== 'active'
    );
  }

  async #readConversationMetadata(
    conversation: ConversationId,
  ): Promise<Record<string, unknown> | undefined> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat) throw new ConversationNotFoundError(conversation.chatId);
    assertConversationOwner(conversation, chat.userId);
    return chat.metadata;
  }

  async #updateConversationMetadata(
    conversation: ConversationId,
    update: (
      metadata: Record<string, unknown> | undefined,
    ) => Record<string, unknown>,
  ): Promise<void> {
    await this.#store.updateChat(conversation.chatId, (chat) => {
      assertConversationOwner(conversation, chat.userId);
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
      return this.#ownsRoot(thread) ? [{ chat, conversation }] : [];
    });

    return Promise.all(
      roots.map(async ({ chat, conversation }) => ({
        chatId: chat.id,
        userId: chat.userId,
        ...(chat.title === undefined ? {} : { title: chat.title }),
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        messageCount: chat.messageCount,
        status: await this.#conversationStatus.read(conversation),
        children: await this.#conversationStatus.children(conversation),
      })),
    );
  }

  work(options?: AgentRuntimeWorkOptions): Promise<AsyncDisposable> {
    const starting = Promise.withResolvers<AsyncDisposable>();
    this.#workers.defer(() =>
      starting.promise.then(
        (worker) => worker[Symbol.asyncDispose](),
        () => {},
      ),
    );
    void this.#startWorkers(options).then(starting.resolve, starting.reject);
    return starting.promise;
  }

  async #startWorkers(
    options: AgentRuntimeWorkOptions | undefined,
  ): Promise<AsyncDisposable> {
    await using workers = new AsyncDisposableStack();
    await this.#plugins.startWorkers(workers);
    const stopsIdleSandboxes = this.#idleStop.stopsIdleSandboxes;
    if (stopsIdleSandboxes) {
      workers.use(await this.#idleStop.work());
    }
    const reconcilesAvailability = this.#plugins.reconcilesAvailability;
    workers.use(
      await this.#queue.consume(this.#executor.execute.bind(this.#executor), {
        concurrency: options?.concurrency,
        onOrphaned: this.#onOrphaned.bind(this),
        onSettled: async ({ chatId, userId }) => {
          // Status first: an arming or a plugin reconciliation failure must
          // not hide the settled transition from host subscribers.
          await this.#conversationStatus.publish({ chatId, userId });
          const followUps = await Promise.allSettled([
            stopsIdleSandboxes
              ? this.#idleStop.arm({ chatId, userId })
              : undefined,
            reconcilesAvailability
              ? this.#plugins.conversationAvailable({ chatId, userId })
              : undefined,
          ]);
          const errors = followUps.flatMap((followUp) =>
            followUp.status === 'rejected' ? [followUp.reason] : [],
          );
          if (errors.length > 0) {
            throw new AggregateError(
              errors,
              `AgentRuntime: settling "${chatId}" failed: ${errors.map((error) => (Error.isError(error) ? error.message : String(error))).join('; ')}`,
            );
          }
        },
      }),
    );
    return workers.move();
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
      const continuation =
        turn.kind === 'recovery' ||
        (turn.kind === 'message' && turn.message.role === 'assistant');
      if (
        continuation &&
        !(turn.kind === 'recovery' && turn.mode === 'idempotent') &&
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
          { ...declaration.tools, ...this.#plugins.tools },
        ))
      ) {
        return;
      }
      if (
        continuation &&
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
        continuation &&
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
        if (
          turn.kind === 'recovery' ||
          (turn.kind === 'message' && turn.message.role === 'assistant')
        ) {
          await this.#queue.resumeParked(turn.chatId);
        }
      } finally {
        await this.#mailbox.endTurn(turn);
      }
    }
  }
}
