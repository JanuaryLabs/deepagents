import type { Telemetry } from 'ai';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  type StreamPart,
  type StreamStatus,
} from '@deepagents/context';

import type { AgentDeclaration } from '../agent.ts';
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
import { loadPluginSkills } from './agent-skills.ts';
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
    turn: TurnRequest,
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
  /** Skill directories installed into every agent sandbox. */
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
      maxConcurrentThreadsPerSession: multiAgent.maxConcurrentThreadsPerSession,
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
      pluginSkills: loadPluginSkills(pluginSkills),
      pluginRuntimeContext,
      configureTelemetry: (context, telemetry) => {
        const contributed = plugins.flatMap(
          ({ instance }) => instance.telemetry?.(context) ?? [],
        );
        if (contributed.length === 0) return telemetry;
        const declared = telemetry?.integrations;
        return {
          ...telemetry,
          integrations: [
            ...(declared === undefined
              ? []
              : Array.isArray(declared)
                ? declared
                : [declared]),
            ...contributed,
          ],
        };
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
      for (const { instance } of this.#plugins) {
        if (instance.work) {
          workers.use(await instance.work(this.#pluginHost));
        }
      }
      workers.use(
        await this.#queue.consume(this.#executor.execute.bind(this.#executor), {
          concurrency: options?.concurrency,
          onOrphaned: this.#onOrphaned.bind(this),
          onSettled: !this.#plugins.some(({ instance }) =>
            Boolean(instance.conversationAvailable),
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
