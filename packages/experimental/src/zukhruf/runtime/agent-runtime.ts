import type { Telemetry } from 'ai';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  type StreamPart,
  type StreamStatus,
} from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../agent.ts';
import { createCollaborationTools } from '../collaboration/collaboration-tools.ts';
import { AgentControlPlane } from '../control-plane/agent-control-plane.ts';
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
import type { TurnQueue, TurnRef, TurnRequest } from '../queue/turn-queue.ts';
import type { ZukhrufToolSet } from '../tool.ts';
import { AgentTurnExecutor } from './agent-turn-executor.ts';
import { ApprovalController } from './approval-controller.ts';
import type { ConversationStatusChangeSource } from './conversation-status/change-source.ts';
import type { ChildProgress } from './conversation-status/child-progress.ts';
import {
  type ConversationStatus,
  type ConversationStatusEvent,
  ConversationStatusProjector,
} from './conversation-status/projector.ts';
import { StatusPublishingTurnQueue } from './conversation-status/status-publishing-turn-queue.ts';
import { loadPluginSkills, selectPluginSkills } from './plugin/agent-skills.ts';
import { loadPluginAgents } from './plugin/plugin-agents.ts';

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
   * Attach the root agent's sandbox for `conversation`. The handle is
   * borrowed: a plugin must never dispose it. The backend is named by
   * `chatId` and re-attached across turns, workers, and restarts (see
   * `SandboxContext` in `agent.ts`), so this works before the conversation
   * exists.
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

  constructor(name: string) {
    this.name = name;
  }

  bind(value: Value): AgentPluginBinding {
    return { capability: this, value };
  }
}

export interface AgentPluginBindings {
  get<Value>(capability: AgentPluginCapability<Value>): Value;
}

export interface AgentPluginInstance {
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
  initialize?(host: AgentPluginHost): Promise<void>;
  work?(host: AgentPluginHost): Promise<AsyncDisposable>;
  conversationAvailable?(
    host: AgentPluginHost,
    conversation: ConversationId,
  ): Promise<void>;
}

export interface AgentPluginDefinition<Instance extends object = object> {
  readonly name: string;
  readonly capabilities?: readonly AgentPluginCapability<unknown>[];
  create(bindings: AgentPluginBindings): AgentPluginInstance & Instance;
}

interface MaterializedAgentPlugin {
  readonly definition: AgentPluginDefinition;
  readonly instance: AgentPluginInstance;
}

function assertRootPluginComposition(
  declared: AgentDeclaration,
  configured: AgentDeclaration,
): void {
  if (declared.plugins === configured.plugins) return;
  if (
    !declared.plugins ||
    !configured.plugins ||
    declared.plugins.length !== configured.plugins.length ||
    declared.plugins.some(
      (definition, index) => configured.plugins?.[index] !== definition,
    )
  ) {
    throw new Error(
      'AgentRuntime: plugins cannot change the root plugin composition',
    );
  }
}

function assertNoSubagentPlugins(root: AgentDeclaration): void {
  const visit = (declaration: AgentDeclaration): void => {
    if (declaration.plugins && declaration.plugins.length > 0) {
      throw new Error(
        `AgentRuntime: subagent "${declaration.name}" cannot declare runtime plugins`,
      );
    }
    for (const subagent of declaration.subagents ?? []) visit(subagent);
  };
  for (const subagent of root.subagents ?? []) visit(subagent);
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
  /** Host implementations for capabilities required by root-owned plugins. */
  bindings?: readonly AgentPluginBinding[];
  /**
   * Cross-process conversation status hints. Without it, status changes are
   * observed only by the process where the transition happened.
   */
  conversationStatusChanges?: ConversationStatusChangeSource;
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
  readonly #conversationStatus: ConversationStatusProjector;
  readonly #executor: AgentTurnExecutor;
  readonly #root: AgentDeclaration;
  readonly #plugins: readonly MaterializedAgentPlugin[];
  readonly #pluginTools: ZukhrufToolSet;
  readonly #pluginHost: AgentPluginHost;
  #initialization?: Promise<void>;

  constructor(root: AgentDeclaration, options: AgentRuntimeOptions) {
    const multiAgent = resolveMultiAgentHostConfig(options.multiAgent);
    let configuredRoot = root;
    const pluginNames = new Set<string>();
    const capabilities = new Map<
      string,
      { capability: AgentPluginCapability<unknown>; plugin: string }
    >();
    if (root.plugins) {
      for (const definition of root.plugins) {
        if (!definition.name.trim()) {
          throw new Error('AgentRuntime: plugin name cannot be empty');
        }
        if (definition.name !== definition.name.trim()) {
          throw new Error(
            `AgentRuntime: plugin name "${definition.name}" must not contain surrounding whitespace`,
          );
        }
        if (pluginNames.has(definition.name)) {
          throw new Error(
            `AgentRuntime: duplicate plugin name "${definition.name}"`,
          );
        }
        pluginNames.add(definition.name);
        if (!definition.capabilities) continue;
        const declaredCapabilities = new Set<AgentPluginCapability<unknown>>();
        for (const capability of definition.capabilities) {
          if (declaredCapabilities.has(capability)) {
            throw new Error(
              `AgentRuntime: plugin "${definition.name}" declares duplicate capability "${capability.name}"`,
            );
          }
          declaredCapabilities.add(capability);
          if (!capability.name.trim()) {
            throw new Error(
              `AgentRuntime: capability name from plugin "${definition.name}" cannot be empty`,
            );
          }
          if (capability.name !== capability.name.trim()) {
            throw new Error(
              `AgentRuntime: capability "${capability.name}" from plugin "${definition.name}" must not contain surrounding whitespace`,
            );
          }
          const existing = capabilities.get(capability.name);
          if (existing && existing.capability !== capability) {
            throw new Error(
              `AgentRuntime: capability "${capability.name}" from plugin "${definition.name}" conflicts with plugin "${existing.plugin}"`,
            );
          }
          if (!existing) {
            capabilities.set(capability.name, {
              capability,
              plugin: definition.name,
            });
          }
        }
      }
    }
    const bindingValues = new Map<AgentPluginCapability<unknown>, unknown>();
    const bindingNames = new Set<string>();
    if (options.bindings) {
      for (const binding of options.bindings) {
        if (bindingNames.has(binding.capability.name)) {
          throw new Error(
            `AgentRuntime: duplicate binding for capability "${binding.capability.name}"`,
          );
        }
        bindingNames.add(binding.capability.name);
        const required = capabilities.get(binding.capability.name);
        if (!required || required.capability !== binding.capability) {
          throw new Error(
            `AgentRuntime: unused binding for capability "${binding.capability.name}"`,
          );
        }
        bindingValues.set(binding.capability, binding.value);
      }
    }
    const plugins: MaterializedAgentPlugin[] = [];
    if (root.plugins) {
      for (const definition of root.plugins) {
        const declared = new Set(definition.capabilities);
        if (definition.capabilities) {
          for (const capability of definition.capabilities) {
            if (!bindingValues.has(capability)) {
              throw new Error(
                `AgentRuntime: plugin "${definition.name}" requires missing capability "${capability.name}"`,
              );
            }
          }
        }
        const instance = definition.create({
          get: <Value>(capability: AgentPluginCapability<Value>): Value => {
            if (!declared.has(capability)) {
              throw new Error(
                `AgentRuntime: plugin "${definition.name}" did not declare capability "${capability.name}"`,
              );
            }
            return bindingValues.get(capability) as Value;
          },
        });
        plugins.push({ definition, instance });
      }
    }
    const pluginTools: ZukhrufToolSet = {};
    const pluginSkills: (string | URL)[] = [];
    const pluginRuntimeContext: Record<string, unknown> = {};
    const runtimeContextOwners = new Map<string, string>([
      ['zukhruf', 'the runtime'],
    ]);
    const collaborationTools = createCollaborationTools(multiAgent);
    const injectedTools = new Map<string, string>(
      Object.keys(collaborationTools).map((name) => [name, 'the runtime']),
    );
    if (multiAgent.codeMode) injectedTools.set('code_mode', 'the runtime');
    for (const { definition, instance } of plugins) {
      for (const [name, tool] of Object.entries(instance.tools ?? {})) {
        const owner = injectedTools.get(name);
        if (owner) {
          throw new Error(
            `AgentRuntime: plugin tool "${name}" from "${definition.name}" conflicts with ${owner}`,
          );
        }
        injectedTools.set(name, `plugin "${definition.name}"`);
        pluginTools[name] = tool;
      }
      if (instance.skills) pluginSkills.push(...instance.skills);
      if (!instance.runtimeContext) continue;
      for (const [name, value] of Object.entries(instance.runtimeContext)) {
        const owner = runtimeContextOwners.get(name);
        if (owner) {
          throw new Error(
            `AgentRuntime: runtime context "${name}" from plugin "${definition.name}" conflicts with ${owner}`,
          );
        }
        runtimeContextOwners.set(name, `plugin "${definition.name}"`);
        pluginRuntimeContext[name] = value;
      }
    }
    for (const { instance } of plugins) {
      if (instance.configure)
        configuredRoot = instance.configure(configuredRoot);
    }
    assertRootPluginComposition(root, configuredRoot);
    assertNoSubagentPlugins(configuredRoot);
    const pluginAgents = loadPluginAgents(
      configuredRoot,
      plugins.flatMap(({ definition, instance }) =>
        instance.agents
          ? [{ plugin: definition.name, directories: instance.agents }]
          : [],
      ),
    );
    if (pluginAgents.declarations.length > 0) {
      configuredRoot = {
        ...configuredRoot,
        subagents: [
          ...(configuredRoot.subagents ?? []),
          ...pluginAgents.declarations,
        ],
      };
    }
    const declarations = new AgentDeclarationRegistry(configuredRoot);
    const loadedPluginSkills = loadPluginSkills(pluginSkills);
    const pluginSkillsByAgent = new Map(
      Array.from(declarations.values(), (declaration) => [
        declaration.name,
        selectPluginSkills(
          loadedPluginSkills,
          declaration.skills ?? [],
          declaration.name,
        ),
      ]),
    );
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
    // Status reads go to the raw queue; every push through the decorated
    // queue publishes the target conversation's status.
    const conversationStatus = new ConversationStatusProjector({
      store: options.store,
      streams,
      queue: options.queue,
      directory,
      changeSource: options.conversationStatusChanges,
    });
    const queue = new StatusPublishingTurnQueue(options.queue, (conversation) =>
      conversationStatus.publish(conversation),
    );
    const mailbox = new MailboxCoordinator({
      store: options.mailboxStore,
      queue,
      streams,
    });
    const approvals = new ApprovalController({
      store: options.store,
      queue,
    });
    const statusProjector = new AgentStatusProjector({
      store: options.store,
      streams,
      queue,
      mailbox,
      directory,
      approvals,
    });
    const historyForker = new AgentHistoryForker(options.store);
    const controlPlane = new AgentControlPlane({
      root: declarations.root,
      streams,
      queue,
      mailbox,
      declarations,
      directory,
      statusProjector,
      historyForker,
      recordActivity: (thread, activity) =>
        conversationStatus.recordActivity(thread, activity),
      maxConcurrentThreadsPerSession: multiAgent.maxConcurrentThreadsPerSession,
    });
    this.#store = options.store;
    this.#queue = queue;
    this.#streams = streams;
    this.#mailbox = mailbox;
    this.#directory = directory;
    this.#controlPlane = controlPlane;
    this.#approvals = approvals;
    this.#conversationStatus = conversationStatus;
    this.#root = declarations.root;
    this.#plugins = plugins;
    this.#pluginTools = pluginTools;
    this.info = {
      root: declarations.root.name,
      agents: Array.from(declarations.values(), (declaration) => ({
        name: declaration.name,
        ...(declaration.description === undefined
          ? {}
          : { description: declaration.description }),
        ...(pluginAgents.owners.has(declaration.name)
          ? { plugin: pluginAgents.owners.get(declaration.name) }
          : {}),
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
      pluginSkillsByAgent,
      pluginRuntimeContext,
      publishConversationStatus: (conversation) =>
        conversationStatus.publish(conversation),
      configureTelemetry: (context, telemetry) => {
        const integrations = plugins.flatMap(
          ({ instance }) => instance.telemetry?.(context) ?? [],
        );
        return integrations.length === 0
          ? telemetry
          : { ...telemetry, integrations };
      },
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
      // Attaches through the declaration directly: resolving the conversation
      // through the control plane would create its root thread.
      sandbox: (conversation) =>
        this.#root.sandbox({
          chatId: conversation.chatId,
          userId: conversation.userId,
        }),
    };
  }

  initialize(): Promise<void> {
    if (!this.#initialization) this.#initialization = this.#initialize();
    return this.#initialization;
  }

  plugin<Instance extends object>(
    definition: AgentPluginDefinition<Instance>,
  ): AgentPluginInstance & Instance {
    const plugin = this.#plugins.find(
      ({ definition: candidate }) => candidate === definition,
    );
    if (!plugin) {
      throw new Error(
        `AgentRuntime: plugin "${definition.name}" does not belong to this runtime`,
      );
    }
    return plugin.instance as AgentPluginInstance & Instance;
  }

  async createSession(conversation: ConversationId): Promise<void> {
    await this.#controlPlane.resolve(conversation);
  }

  async sessionExists(conversation: ConversationId): Promise<boolean> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat || chat.userId !== conversation.userId) return false;
    return (await this.#directory.load(conversation))?.path.isRoot ?? false;
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
      () => this.#conversationAvailable(conversation),
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
        ? [{ chat, conversation }]
        : [];
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

  async work(options?: AgentRuntimeWorkOptions): Promise<AsyncDisposable> {
    await this.initialize();
    const workers = new AsyncDisposableStack();
    try {
      for (const { instance } of this.#plugins) {
        if (instance.work) {
          workers.use(await instance.work(this.#pluginHost));
        }
      }
      const reconcilesAvailability = this.#plugins.some(({ instance }) =>
        Boolean(instance.conversationAvailable),
      );
      workers.use(
        await this.#queue.consume(this.#executor.execute.bind(this.#executor), {
          concurrency: options?.concurrency,
          onOrphaned: this.#onOrphaned.bind(this),
          onSettled: async ({ chatId, userId }) => {
            // Status first: a plugin reconciliation failure must not hide
            // the settled transition from host subscribers.
            await this.#conversationStatus.publish({ chatId, userId });
            if (reconcilesAvailability) {
              await this.#conversationAvailable({ chatId, userId });
            }
          },
        }),
      );
      return workers;
    } catch (error) {
      await workers.disposeAsync();
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    for (const { instance } of this.#plugins) {
      await instance.initialize?.(this.#pluginHost);
    }
  }

  async #conversationAvailable(conversation: ConversationId): Promise<void> {
    const errors: unknown[] = [];
    for (const { instance } of this.#plugins) {
      try {
        await instance.conversationAvailable?.(this.#pluginHost, conversation);
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
          { ...declaration.tools, ...this.#pluginTools },
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
