import { Latch } from '@zukhruf/async';
import type { Telemetry } from 'ai';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type ChatInfo,
  ContextEngine,
  type ContextStore,
  type StreamManager,
  type StreamPart,
  type StreamStatus,
} from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../agent.ts';
import { Team } from '../collaboration/team.ts';
import { AgentControlPlane } from '../control-plane/agent-control-plane.ts';
import type { AgentDeclarationRegistry } from '../control-plane/agent-declaration-registry.ts';
import { AgentDirectory } from '../control-plane/agent-directory.ts';
import { AgentResidency } from '../control-plane/agent-residency.ts';
import { AgentStatusProjector } from '../control-plane/agent-status-projector.ts';
import { AgentThread } from '../control-plane/agent-thread.ts';
import { AgentTurnId } from '../control-plane/agent-turn-id.ts';
import {
  ConversationArchivedError,
  ConversationNotArchivedError,
} from '../control-plane/conversation-archived-error.ts';
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
import type { AdmissionScope, AgentStorage } from '../storage/agent-storage.ts';
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
import { TurnSettlement } from './turn-settlement.ts';

/** How long a delete waits for a running turn to exit before it carries on: Codex's wait_for_thread_shutdown bound. */
const SHUTDOWN_TIMEOUT_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;

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
  /**
   * The conversation may be available again: one of its turns has settled,
   * or a queued turn of it was cancelled. Runs from a durable intent on the
   * plugin's own queue, at least once, on any worker that has this plugin,
   * so it must be idempotent and safe to run concurrently on other hosts. A
   * conversation deleted or archived meanwhile must resolve. A rejection is
   * retried with backoff, up to 20 times; throw a `NonRetryableError` (or a
   * subclass) for a failure no retry can fix, such as corrupt stored state:
   * it is reported once as a process warning and not retried.
   */
  conversationAvailable?(conversation: ConversationId): Promise<void>;
  /** The conversation is being deleted; its metadata is still readable. Must be idempotent; a rejection aborts the delete. */
  conversationDeleting?(conversation: ConversationId): Promise<void>;
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
  /** When the session was archived; absent while it is not. */
  readonly archivedAt?: number;
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
  readonly #recordCancelled: (streamId: string) => Promise<void>;

  constructor(
    conversation: ConversationId,
    store: ContextStore,
    directory: AgentDirectory,
    streams: StreamManager,
    queue: TurnQueue,
    status: AgentObservationStatus,
    recordCancelled: (streamId: string) => Promise<void>,
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
    this.#recordCancelled = recordCancelled;
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
      // A cancelled queued turn never runs, so nothing else settles it.
      await this.#recordCancelled(id);
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
  /**
   * Removes what the host keeps per conversation outside the framework
   * (volumes, object-storage prefixes). Called once per delete with every
   * member, after every sandbox is deleted and before any row goes; must
   * resolve when the data is already gone. A rejection aborts the delete; a
   * retry calls it again with the same ids.
   */
  conversationDataCleanup?: (
    conversations: readonly ConversationId[],
  ) => Promise<void>;
}>;

/** Defines infrastructure without acquiring it; each initialization opens its own scope. */
export function defineStack(create: AgentStack): AgentStack {
  return create;
}

/** The agents of a tree, the deepest first, so a tree's root comes last. */
function deepestFirst(threads: readonly AgentThread[]): AgentThread[] {
  const depth = (thread: AgentThread) =>
    thread.path.toString().split('/').length;
  return threads.toSorted((left, right) => depth(right) - depth(left));
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
  readonly #residency: AgentResidency;
  readonly #approvals: ApprovalController;
  readonly #conversationStatus: ConversationStatusProjector;
  readonly #executor: AgentTurnExecutor;
  readonly #root: AgentDeclaration;
  readonly #plugins: PluginManager;
  readonly #pluginHost: AgentPluginHost;
  readonly #idleStop: SandboxIdleStop | undefined;
  /** Opened by `initialize`, once the plugins' follow-ups are known; AgentRuntime hands out a host only after that. */
  readonly #settlement = new Latch<TurnSettlement>();
  readonly #storage: AgentStorage;
  readonly #declarations: AgentDeclarationRegistry;
  readonly #sandboxes: ConversationSandboxes;
  readonly #conversationDataCleanup: Awaited<
    ReturnType<AgentStack>
  >['conversationDataCleanup'];

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
    this.#storage = storage;
    this.#conversationDataCleanup = options.conversationDataCleanup;
    this.#declarations = declarations;
    this.#store = storage.store;
    this.#queue = queue;
    this.#streams = streams;
    this.#mailbox = mailbox;
    this.#directory = directory;
    this.#controlPlane = controlPlane;
    this.#residency = residency;
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
    const sandboxes = resources.use(
      new ConversationSandboxes({
        reopenable: async (chat) => {
          const thread = await this.#directory.load(chat);
          return thread !== undefined && !(await this.#inDeletedTree(thread));
        },
      }),
    );
    this.#sandboxes = sandboxes;
    this.#idleStop = SandboxIdleStop.of({
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
      idleStop: this.#idleStop,
      settlement: {
        complete: async (turn) =>
          (await this.#settlement.wait()).complete(turn),
        completeEmptyWake: async (turn) =>
          (await this.#settlement.wait()).completeEmptyWake(turn),
      },
      publishConversationStatus: (conversation) =>
        conversationStatus.publish(conversation),
      inArchivedTree: async (thread) =>
        (await directory.rootOf(thread))?.archivedAt !== undefined,
      resumeParked: (chatId) => this.#queue.resumeParked(chatId),
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
      // A chat with no agent yet opens its sandbox (an upload before the
      // first message); one of a tree being deleted, and a deleted one, reads
      // as absent.
      sandbox: async (conversation) => {
        const thread = await this.#directory.load(conversation);
        const refused =
          thread === undefined
            ? await storage.deletedConversations.has(conversation.chatId)
            : await this.#inDeletedTree(thread);
        if (refused) {
          throw new ConversationNotFoundError(conversation.chatId);
        }
        const sandbox = await sandboxes.acquire(this.#root, {
          chatId: conversation.chatId,
          userId: conversation.userId,
        });
        // The borrow can start the sandbox, so its idle window starts too.
        await this.#idleStop?.armAfterBorrow(conversation);
        return sandbox;
      },
    };
    resources.use(this.#workers);
  }

  async initialize(): Promise<void> {
    await this.#plugins.initialize(this.#pluginHost);
    const settlement = await TurnSettlement.open({
      storage: this.#storage,
      directory: this.#directory,
      streams: this.#streams.store,
      queue: this.#queue,
      inDeletedTree: (thread) => this.#inDeletedTree(thread),
      followUps: [
        ...(this.#idleStop ? [this.#idleStop] : []),
        ...this.#plugins.settleFollowUps,
      ],
    });
    this.#settlement.open(settlement);
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

  /** Creates the root chat, or keeps a chat of a tree this runtime owns (its root or a sub-agent); any other chat, one of a tree being deleted and a deleted one read as absent. */
  async createSession(conversation: ConversationId): Promise<void> {
    // A new root is created in an admission, which a deleted id's tombstone refuses.
    const thread =
      (await this.#directory.load(conversation)) ??
      (await this.#residency.admit(conversation, (admission) =>
        admission.directory.loadOrCreateRoot(conversation, this.#root.name),
      ));
    const root = await this.#directory.rootOf(thread);
    if (!root || !this.#ownsRoot(root) || root.deletingAt !== undefined) {
      throw new ConversationNotFoundError(conversation.chatId);
    }
  }

  /** Whether the tree `thread` is in is being deleted, or its root is gone. */
  async #inDeletedTree(thread: AgentThread): Promise<boolean> {
    const root = await this.#directory.rootOf(thread);
    return root === undefined || root.deletingAt !== undefined;
  }

  async sessionExists(conversation: ConversationId): Promise<boolean> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat || chat.userId !== conversation.userId) return false;
    const thread = await this.#directory.load(conversation);
    return (
      thread !== undefined &&
      this.#ownsRoot(thread) &&
      thread.deletingAt === undefined
    );
  }

  /**
   * Deletes a root chat this runtime owns and every sub-agent chat under it:
   * their sandboxes, queued turns, idle stops, mail, streams and chat rows.
   * The root is marked first, in its tree's admission, so from then on the
   * tree admits nothing and reads as absent; then the tree's turns are
   * stopped, waiting at most 10 s for a running one; each plugin's
   * conversationDeleting gets each member, whose metadata is still readable,
   * so it removes its own state, such as wakes; once the sandboxes are
   * deleted, the stack's conversationDataCleanup gets every member; the rows
   * go last, deepest first and the root last, in one admission for the tree,
   * which leaves each member's tombstone, so its id is refused from then on,
   * on every worker; then each member's status is published, which
   * subscribers receive as `deleted`. A delete cut short leaves the marked root, and calling this again
   * finishes it. Any other chat, and one already deleted, rejects with
   * ConversationNotFoundError.
   */
  async deleteSession(conversation: ConversationId): Promise<void> {
    const tree = { userId: conversation.userId, treeId: conversation.chatId };
    const root = await this.#storage.admit(tree, async (scope) => {
      const directory = new AgentDirectory(scope.store);
      const thread = await directory.load(conversation);
      if (!thread || !this.#ownsRoot(thread)) {
        throw new ConversationNotFoundError(conversation.chatId);
      }
      await directory.markDeleting(conversation, Date.now());
      return thread;
    });
    const members = deepestFirst(await this.#directory.listTree(root));
    await this.#stopLiveWork(members.map(({ conversation }) => conversation));
    for (const { conversation: member } of members) {
      await this.#plugins.conversationDeleting(member);
    }
    for (const member of members) {
      const declaration = this.#declarations.get(member.declarationName);
      if (!declaration) {
        throw new Error(
          `AgentRuntime.deleteSession: unknown agent declaration "${member.declarationName}" of chat "${member.conversation.chatId}"`,
        );
      }
      await this.#idleStop?.cancel(member);
      await this.#sandboxes.forget(declaration, member.conversation);
      await declaration.sandbox.environment.delete(member.conversation);
    }
    await this.#conversationDataCleanup?.(
      members.map(({ conversation }) => conversation),
    );
    const deletedAt = Date.now();
    await this.#storage.admit(tree, async (scope) => {
      for (const { conversation: member } of members) {
        await scope.mailboxStore.forget(member);
        const streamIds = await scope.streams.listStreamIds({
          prefix: AgentTurnId.prefixOf(member),
        });
        for (const streamId of streamIds) {
          await scope.streams.deleteStream(streamId);
        }
        await scope.store.deleteChat(member.chatId, { userId: member.userId });
        await scope.deletedConversations.add(member.chatId, deletedAt);
      }
    });
    for (const { conversation: member } of members) {
      await this.#conversationStatus.publish(member);
    }
  }

  /**
   * Stops the turns of a tree being deleted, as Codex shuts a thread down
   * before it deletes it: each member's queued and parked jobs go first, so
   * none is claimed meanwhile; its queued and running streams are cancelled,
   * which aborts a running turn on any worker; the running turns get at most
   * 10 s to exit, and the delete carries on after that; then the jobs are
   * forgotten again, for a turn that parked or failed on its way out.
   */
  async #stopLiveWork(members: readonly ConversationId[]): Promise<void> {
    for (const member of members) {
      await this.#queue.forget(member);
      await this.#cancelTurns(member, ['queued', 'running']);
    }
    await this.#awaitShutdown(members);
    for (const member of members) {
      await this.#queue.forget(member);
    }
  }

  /** Cancels the member's turns whose streams have one of `statuses`, which aborts a running one on any worker. */
  async #cancelTurns(
    member: ConversationId,
    statuses: readonly ('queued' | 'running')[],
  ): Promise<void> {
    const prefix = AgentTurnId.prefixOf(member);
    for (const status of statuses) {
      for (const streamId of await this.#streams.store.listStreamIds({
        prefix,
        status,
      })) {
        await this.#streams.cancel(streamId);
        await this.#queue.cancel(streamId);
      }
    }
  }

  /** Waits at most 10 s in all for the members' running turns to exit, as Codex waits for a thread's shutdown. */
  async #awaitShutdown(members: readonly ConversationId[]): Promise<void> {
    const deadline = performance.now() + SHUTDOWN_TIMEOUT_MS;
    for (const member of members) {
      while ((await this.#queue.getTurnActivity(member)) === 'running') {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await delay(Math.min(SHUTDOWN_POLL_INTERVAL_MS, remaining));
      }
    }
  }

  /**
   * Archives a root chat this runtime owns and every sub-agent chat under
   * it, as Codex's thread/archive does. One admission to the tree marks
   * every member archived, so from then on the tree admits no turn through
   * enqueue, a user's or a plugin's, and a turn queued before the archive
   * is parked when a worker claims it; the same admission schedules the
   * stop of each member's sandbox that can stop, due at once. Then the
   * stops each member's latest turn armed are cancelled, its running turns
   * are cancelled, the root first and then its descendants, deepest first,
   * waiting at most 10 s for them to exit; then each member's status is
   * published, which subscribers receive as `archived`. Everything stays
   * readable, and mail still runs a member's turn, as collaboration resumes
   * an archived agent. An archived root rejects with
   * ConversationArchivedError; any other chat, and one being deleted, with
   * ConversationNotFoundError.
   */
  async archiveSession(conversation: ConversationId): Promise<void> {
    const archivedAt = Date.now();
    const members = await this.#markTree(
      conversation,
      (root) => {
        if (root.archivedAt !== undefined) {
          throw new ConversationArchivedError(conversation.chatId);
        }
      },
      async (scope, directory, member) => {
        await directory.markArchived(member.conversation, archivedAt);
        await this.#idleStop?.archive(scope, member, archivedAt);
      },
    );
    // As read before the mark, each finds the stop its latest turn armed.
    for (const member of members) await this.#idleStop?.cancel(member);
    // Codex shuts the root down first, then its descendants in reverse.
    const order = [
      ...members.filter(({ path }) => path.isRoot),
      ...deepestFirst(members.filter(({ path }) => !path.isRoot)),
    ].map(({ conversation: member }) => member);
    for (const member of order) await this.#cancelTurns(member, ['running']);
    await this.#awaitShutdown(order);
    for (const member of order) await this.#conversationStatus.publish(member);
  }

  /**
   * Unarchives a root chat this runtime owns and every sub-agent chat under
   * it, as Codex's thread/unarchive does: one admission to the tree clears
   * every member's mark, then each member's parked turns are resumed, the
   * ones queued before the archive among them, and each member's status is
   * published, which subscribers receive as `unarchived`. It starts no
   * sandbox; the next turn does. Resolves with the session's history item.
   * A root that is not archived rejects with ConversationNotArchivedError;
   * any other chat, and one being deleted, with ConversationNotFoundError.
   */
  async unarchiveSession(
    conversation: ConversationId,
  ): Promise<AgentHistoryItem> {
    const members = await this.#markTree(
      conversation,
      (root) => {
        if (root.archivedAt === undefined) {
          throw new ConversationNotArchivedError(conversation.chatId);
        }
      },
      (_scope, directory, member) =>
        directory.markUnarchived(member.conversation),
    );
    for (const { conversation: member } of members) {
      await this.#queue.resumeParked(member.chatId);
    }
    for (const { conversation: member } of members) {
      await this.#conversationStatus.publish(member);
    }
    const chat = (
      await this.#store.listChats({
        userId: conversation.userId,
        metadata: AgentThread.metadataFilter(conversation.chatId),
      })
    ).find(({ id }) => id === conversation.chatId);
    if (!chat) throw new ConversationNotFoundError(conversation.chatId);
    const root = AgentThread.fromMetadata(conversation, chat.metadata);
    if (!root) throw new ConversationNotFoundError(conversation.chatId);
    return this.#historyItem(chat, root);
  }

  /**
   * In one admission to the tree of `conversation`, a root this runtime owns
   * that is not being deleted and that `assertMarkable` accepts, applies
   * `mark` to every member, and resolves with the members as they were
   * before it.
   */
  async #markTree(
    conversation: ConversationId,
    assertMarkable: (root: AgentThread) => void,
    mark: (
      scope: AdmissionScope,
      directory: AgentDirectory,
      member: AgentThread,
    ) => Promise<void>,
  ): Promise<AgentThread[]> {
    const tree = { userId: conversation.userId, treeId: conversation.chatId };
    return this.#storage.admit(tree, async (scope) => {
      const directory = new AgentDirectory(scope.store);
      const root = await directory.load(conversation);
      if (!root || !this.#ownsRoot(root) || root.deletingAt !== undefined) {
        throw new ConversationNotFoundError(conversation.chatId);
      }
      assertMarkable(root);
      const members = await directory.listTree(root);
      for (const member of members) await mark(scope, directory, member);
      return members;
    });
  }

  /** A root thread this runtime's root declaration started. */
  #ownsRoot(thread: AgentThread): boolean {
    return thread.path.isRoot && thread.declarationName === this.info.root;
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
      async (streamId) =>
        (await this.#settlement.wait()).complete({
          ...conversation,
          streamId,
        }),
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

  /** The sessions of this runtime: by default the ones not archived, and with `archived: true` only the archived ones, like Codex's thread/list. */
  async listHistory(
    userId?: string,
    options?: { archived?: boolean },
  ): Promise<readonly AgentHistoryItem[]> {
    const archived = options?.archived ?? false;
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
      return this.#ownsRoot(thread) &&
        thread.deletingAt === undefined &&
        (thread.archivedAt !== undefined) === archived
        ? [{ chat, thread }]
        : [];
    });

    return Promise.all(
      roots.map(({ chat, thread }) => this.#historyItem(chat, thread)),
    );
  }

  async #historyItem(
    chat: ChatInfo,
    root: AgentThread,
  ): Promise<AgentHistoryItem> {
    const { conversation } = root;
    return {
      chatId: chat.id,
      userId: chat.userId,
      ...(chat.title === undefined ? {} : { title: chat.title }),
      ...(root.archivedAt === undefined ? {} : { archivedAt: root.archivedAt }),
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: chat.messageCount,
      status: await this.#conversationStatus.read(conversation),
      children: await this.#conversationStatus.children(conversation),
    };
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
    if (this.#idleStop) workers.use(await this.#idleStop.work());
    workers.use(await (await this.#settlement.wait()).work());
    workers.use(
      await this.#queue.consume(this.#executor.execute.bind(this.#executor), {
        concurrency: options?.concurrency,
        onOrphaned: this.#onOrphaned.bind(this),
        // The follow-ups run from the intents the turn's completion recorded.
        onSettled: ({ chatId, userId }) =>
          this.#conversationStatus.publish({ chatId, userId }),
      }),
    );
    return workers.move();
  }

  /**
   * Reconciles a turn whose handler crashed or whose worker died, then
   * completes a settled one, recording its settle intents before the queue
   * releases its job. A turn whose reconciliation fails records none; the
   * dead-letter queue tries it again.
   */
  async #onOrphaned(turn: TurnRef, error: string): Promise<void> {
    try {
      if (await this.#reconcileOrphan(turn, error)) {
        await (await this.#settlement.wait()).complete(turn);
      }
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

  /**
   * Reconciles an orphaned turn. Whether it settled: not when its stream is
   * gone with its deleted chat, or when a recovery turn it pushed for the
   * same stream will settle it.
   */
  async #reconcileOrphan(turn: TurnRef, error: string): Promise<boolean> {
    let stream = await this.#streams.store.getStream(turn.streamId);
    // Every push registers its stream first, so a turn whose stream is
    // gone belongs to a deleted chat; resolving it would create the chat
    // again.
    if (stream === undefined) return false;
    const firstReconciliation =
      stream.status === 'queued' || stream.status === 'running';
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
      (await this.#approvals.retryIdempotentContinuation(turn, turn.streamId, {
        ...declaration.tools,
        ...this.#plugins.tools,
      }))
    ) {
      return false;
    }
    if (
      continuation &&
      stream?.status === 'completed' &&
      (await this.#approvals.recoverUnstartedContinuation(turn, turn.streamId))
    ) {
      return false;
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
    return true;
  }
}
