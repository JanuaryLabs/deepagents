import { experimental_codeModeTool } from '@ai-sdk/code-mode';
import { type UIMessage, jsonSchema, tool } from 'ai';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type AvailableSkill,
  ContextEngine,
  type ContextStore,
  type StreamManager,
  agent,
  assistant,
  chat,
  role,
  user,
} from '@deepagents/context';
import { type ElementDescriptor, elementsSchema } from '@deepagents/elements';
import {
  elementsFragment,
  elementsStreamTransform,
} from '@deepagents/elements/context';

import type { ZukhrufSandbox } from '../agent.ts';
import type { AgentToolContext } from '../collaboration/agent-tool-context.ts';
import type { AgentControlPlane } from '../control-plane/agent-control-plane.ts';
import type { MailboxCoordinator } from '../mailbox/coordinator.ts';
import type {
  ConversationId,
  InterAgentCommunication,
} from '../mailbox/types.ts';
import type { ResolvedMultiAgentHostConfig } from '../multi-agent-config.ts';
import type { ConsumeContext, TurnRef } from '../queue/turn-queue.ts';
import type { AgentPluginToolContext } from './agent-runtime.ts';
import type { ApprovalController } from './approval-controller.ts';
import {
  type AgentSkills,
  createAgentSkills,
  discoverAgentSkills,
} from './plugin/agent-skills.ts';
import type { PluginManager } from './plugin/plugin-manager.ts';

type TurnPlugins = Pick<
  PluginManager,
  | 'collaborationTools'
  | 'tools'
  | 'skillsByAgent'
  | 'runtimeContext'
  | 'configureTelemetry'
>;

export interface AgentTurnExecutorOptions {
  store: ContextStore;
  streams: StreamManager;
  controlPlane: AgentControlPlane;
  mailbox: MailboxCoordinator;
  approvals: ApprovalController;
  multiAgent: ResolvedMultiAgentHostConfig;
  plugins: TurnPlugins;
  /** Signals that the conversation's status may have changed. Never rejects. */
  publishConversationStatus: (conversation: ConversationId) => Promise<void>;
}

interface SamplingMailboxState {
  firstRequest: boolean;
}

/** Executes one queued turn without owning host lifecycle or agent routing. */
export class AgentTurnExecutor {
  readonly #store: ContextStore;
  readonly #streams: StreamManager;
  readonly #controlPlane: AgentControlPlane;
  readonly #mailbox: MailboxCoordinator;
  readonly #approvals: ApprovalController;
  readonly #multiAgent: ResolvedMultiAgentHostConfig;
  readonly #plugins: TurnPlugins;
  readonly #publishConversationStatus: AgentTurnExecutorOptions['publishConversationStatus'];

  constructor(options: AgentTurnExecutorOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#controlPlane = options.controlPlane;
    this.#mailbox = options.mailbox;
    this.#approvals = options.approvals;
    this.#multiAgent = options.multiAgent;
    this.#plugins = options.plugins;
    this.#publishConversationStatus = options.publishConversationStatus;
  }

  async execute(turn: TurnRef, context: ConsumeContext): Promise<void> {
    if (turn.kind === 'recovery') {
      await this.#reopen(turn.streamId);
    }
    if (await this.#projectSkippedTerminalTurn(turn)) return;

    let parked = false;
    await this.#mailbox.beginTurn(turn);
    try {
      await this.#executeTurn(turn, {
        ...context,
        park: async () => {
          parked = true;
          await context.park();
          // A parked turn never settles through the queue, so its
          // "waiting on approval" status is published here.
          await this.#publishConversationStatus(turn);
        },
      });
    } finally {
      await this.#mailbox.endTurn(turn, { parked });
    }
  }

  async #executeTurn(
    turn: TurnRef,
    { signal, park }: ConsumeContext,
  ): Promise<void> {
    if (await this.#projectSkippedTerminalTurn(turn)) return;

    const { declaration, thread } = await this.#controlPlane.resolve(turn);
    const usageHint = thread.path.isRoot
      ? this.#multiAgent.rootAgentUsageHintText
      : this.#multiAgent.subagentUsageHintText;
    const engine = this.#engineFor(turn).set(
      ...declaration.instructions,
      ...(usageHint === undefined ? [] : [role(usageHint)]),
    );

    if (
      (turn.kind === 'message' && turn.message.role === 'user') ||
      turn.kind === 'mailbox'
    ) {
      const head = (await engine.getMessages()).at(-1);
      if (this.#approvals.isPaused(head)) {
        await park();
        return;
      }
    }

    let communications: InterAgentCommunication[] = [];
    if (turn.kind === 'message' && turn.message.role === 'user') {
      communications = await this.#mailbox.drainLeadingQueueOnly(turn);
    } else if (turn.kind === 'mailbox') {
      communications = await this.#mailbox.drain(turn);
    }

    if (turn.kind === 'mailbox' && communications.length === 0) {
      // Duplicate wakes are harmless scheduling receipts once mail is gone.
      await this.#streams.store.updateStreamStatus(turn.streamId, 'completed');
      return;
    }

    await this.#controlPlane.recordLatestTurn(turn, turn.streamId);
    await this.#prepareChain(turn, engine, communications);

    const sandbox = await declaration.sandbox({
      chatId: turn.chatId,
      userId: turn.userId,
    });
    const agentSkills = await this.#skillsFor(
      turn,
      declaration.name,
      sandbox,
      signal,
    );
    engine.set(...agentSkills.fragments);
    const elements = await this.#elementsFor(turn);
    if (elements.length > 0) {
      engine.set(elementsFragment(elements));
    }

    if (await this.#projectSkippedTerminalTurn(turn)) return;
    if (!(await this.#streams.claim(turn.streamId))) {
      await this.#projectSkippedTerminalTurn(turn);
      return;
    }
    // Claimed = genuinely running. Parked, skipped, and empty-wake turns never
    // reach this point, so they cannot flash an "active" status.
    await this.#publishConversationStatus(turn);
    const agentContext = {
      controlPlane: this.#controlPlane,
      actor: { turn, thread, declaration },
    } satisfies AgentToolContext;
    const pluginContext = {
      conversation: { chatId: turn.chatId, userId: turn.userId },
      treeId: thread.treeId,
      streamId: turn.streamId,
      agentName: declaration.name,
      agentPath: thread.path.toString(),
    } satisfies AgentPluginToolContext;
    const mailboxState: SamplingMailboxState = { firstRequest: true };
    const agentOptions = {
      name: declaration.name,
      model: declaration.model,
      sandbox,
      context: engine,
      telemetry: this.#plugins.configureTelemetry(
        pluginContext,
        declaration.telemetry,
      ),
      runtimeContext: {
        ...this.#plugins.runtimeContext,
        zukhruf: {
          chatId: turn.chatId,
          userId: turn.userId,
          streamId: turn.streamId,
          agentName: declaration.name,
          agentPath: thread.path.toString(),
        },
      },
      prepareStepInput: () => this.#prepareStepInput(turn, mailboxState),
      ...(this.#multiAgent.codeMode
        ? {
            experimental_toolCallers: Object.fromEntries(
              Object.keys(this.#plugins.collaborationTools).map((name) => [
                name,
                ['code_mode'] as const,
              ]),
            ),
          }
        : {}),
    };
    const modelTools = {
      ...(turn.kind === 'message'
        ? Object.fromEntries(
            Object.entries(turn.tools ?? {}).map(([name, definition]) => [
              name,
              tool({
                description: definition.description,
                inputSchema: jsonSchema(definition.inputSchema),
              }),
            ]),
          )
        : {}),
      ...declaration.tools,
      ...this.#plugins.collaborationTools,
      ...(this.#multiAgent.codeMode
        ? { code_mode: experimental_codeModeTool() }
        : {}),
      ...this.#plugins.tools,
    };
    const collaborationToolsContext = {
      spawn_agent: agentContext,
      send_message: agentContext,
      followup_task: agentContext,
      list_agents: agentContext,
      wait_agent: agentContext,
      interrupt_agent: agentContext,
      ...(this.#multiAgent.codeMode ? { code_mode: agentContext } : {}),
      ...Object.fromEntries(
        Object.keys(this.#plugins.tools).map((name) => [name, pluginContext]),
      ),
    };

    const abort = new AbortController();
    const onWorkerAbort = () => abort.abort();
    signal.addEventListener('abort', onWorkerAbort, { once: true });
    try {
      const setupCancellation = this.#streams.monitorCancellation(
        turn.streamId,
        () => abort.abort(),
      );
      let stream: Awaited<ReturnType<typeof chat>>;
      try {
        stream = await chat(
          agent({
            ...agentOptions,
            tools: modelTools,
          }),
          {
            abortSignal: abort.signal,
            toolsContext: collaborationToolsContext,
            ...(elements.length > 0
              ? { transform: [elementsStreamTransform] }
              : {}),
          },
        );
      } finally {
        await setupCancellation[Symbol.asyncDispose]();
      }
      await this.#streams.persist(stream, turn.streamId, {
        preclaimed: true,
        onCancelDetected: () => abort.abort(),
      });
      if (
        turn.kind === 'recovery' ||
        (turn.kind === 'message' && turn.message.role === 'assistant')
      ) {
        await this.#reconcileTerminalContinuation(turn);
      }
      await this.#controlPlane.projectTerminal(turn, thread);
    } finally {
      signal.removeEventListener('abort', onWorkerAbort);
    }
  }

  async #projectSkippedTerminalTurn(turn: TurnRef): Promise<boolean> {
    const status = await this.#streams.store.getStreamStatus(turn.streamId);
    if (status === 'queued' || status === 'running') return false;
    if (status === undefined || turn.kind === 'mailbox') return true;

    if (
      turn.kind === 'recovery' ||
      (turn.kind === 'message' && turn.message.role === 'assistant')
    ) {
      await this.#reconcileTerminalContinuation(turn);
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

  async #reconcileTerminalContinuation(turn: TurnRef): Promise<void> {
    const stream = await this.#streams.store.getStream(turn.streamId);
    if (
      stream?.status !== 'completed' &&
      stream?.status !== 'failed' &&
      stream?.status !== 'cancelled'
    ) {
      return;
    }
    await this.#approvals.reconcileTerminalContinuation(
      turn,
      turn.streamId,
      stream.status,
      stream.error,
    );
  }

  async #reopen(streamId: string): Promise<void> {
    const status = await this.#streams.store.getStreamStatus(streamId);
    if (status === 'queued' || status === 'running') return;
    await this.#streams.reopen(streamId);
  }

  async #prepareChain(
    turn: TurnRef,
    engine: ContextEngine,
    communications: InterAgentCommunication[],
  ): Promise<void> {
    if (turn.kind === 'message') {
      if (turn.message.role === 'assistant') {
        await engine.continue(assistant(turn.message));
      } else if (turn.trigger === 'regenerate-message') {
        await engine.rewind(turn.message.id);
        engine.set(
          assistant({ id: turn.streamId, role: 'assistant', parts: [] }),
        );
        await engine.save({ branch: false });
      } else {
        engine.set(
          ...communications.map((communication) =>
            user(this.#mailboxInputMessage(communication)),
          ),
          user(turn.message),
          assistant({ id: turn.streamId, role: 'assistant', parts: [] }),
        );
        await engine.save({ branch: true });
      }
    } else if (turn.kind === 'mailbox') {
      engine.set(
        ...communications.map((communication) =>
          user(this.#mailboxInputMessage(communication)),
        ),
        assistant({ id: turn.streamId, role: 'assistant', parts: [] }),
      );
      await engine.save({ branch: true });
    }
  }

  async #prepareStepInput(
    turn: TurnRef,
    state: SamplingMailboxState,
  ): Promise<Array<UIMessage & { role: 'user' }> | undefined> {
    const communications =
      turn.kind === 'message' &&
      turn.message.role === 'user' &&
      state.firstRequest
        ? await this.#mailbox.drainLeadingQueueOnly(turn)
        : await this.#mailbox.drain(turn);
    state.firstRequest = false;
    return communications.length === 0
      ? undefined
      : communications.map((communication) =>
          this.#mailboxInputMessage(communication),
        );
  }

  /**
   * Resolve the interactive-element catalog for this turn and keep the
   * chat's durable snapshot current. A `message` turn carrying an `elements`
   * key is authoritative (an empty array clears the snapshot); every other
   * turn — recovery and mailbox included — renders with the stored snapshot,
   * so re-executions see the same catalog as the turn they replay.
   */
  async #elementsFor(turn: TurnRef): Promise<ElementDescriptor[]> {
    if (turn.kind === 'message' && turn.elements !== undefined) {
      const declared = turn.elements;
      await this.#store.updateChat(turn.chatId, ({ metadata }) => {
        const zukhruf = isRecord(metadata?.zukhruf) ? metadata.zukhruf : {};
        if (isDeepStrictEqual(zukhruf.elements, declared)) return undefined;
        return {
          metadata: {
            ...metadata,
            zukhruf: { ...zukhruf, elements: declared },
          },
        };
      });
      return declared;
    }
    const chat = await this.#store.getChat(turn.chatId);
    return readElements(chat?.metadata) ?? [];
  }

  async #skillsFor(
    turn: TurnRef,
    agentName: string,
    sandbox: ZukhrufSandbox,
    signal: AbortSignal,
  ): Promise<AgentSkills> {
    const chat = await this.#store.getChat(turn.chatId);
    const existing = readSkills(chat?.metadata);
    if (existing !== undefined)
      return this.#withPluginSkills(existing, agentName, sandbox);
    if (sandbox.workingDirectory === undefined) {
      return this.#withPluginSkills([], agentName, sandbox);
    }

    const discovered = await discoverAgentSkills(sandbox, signal);
    let available = discovered.available;
    await this.#store.updateChat(turn.chatId, ({ metadata }) => {
      const persisted = readSkills(metadata);
      if (persisted !== undefined) {
        available = persisted;
        return undefined;
      }

      const zukhruf = isRecord(metadata?.zukhruf) ? metadata.zukhruf : {};
      return {
        metadata: {
          ...metadata,
          zukhruf: { ...zukhruf, skills: available },
        },
      };
    });
    return this.#withPluginSkills(available, agentName, sandbox);
  }

  async #withPluginSkills(
    available: readonly AvailableSkill[],
    agentName: string,
    sandbox: ZukhrufSandbox,
  ): Promise<AgentSkills> {
    const pluginSkills = this.#plugins.skillsByAgent.get(agentName);
    if (!pluginSkills || pluginSkills.available.length === 0) {
      return createAgentSkills(available);
    }
    if (sandbox.workingDirectory === undefined) {
      throw new Error(
        'AgentRuntime: plugin skills require a sandbox workingDirectory',
      );
    }
    const workingDirectory = sandbox.workingDirectory;
    const names = new Set(available.map(({ name }) => name));
    const duplicate = pluginSkills.available.find(({ name }) =>
      names.has(name),
    );
    if (duplicate) {
      throw new Error(`AgentRuntime: duplicate skill "${duplicate.name}"`);
    }
    await sandbox.sandbox.writeFiles(
      pluginSkills.files.map(({ path: relativePath, content }) => ({
        path: path.posix.join(workingDirectory, relativePath),
        content,
      })),
    );
    return createAgentSkills(
      [...available, ...pluginSkills.available].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    );
  }

  #engineFor({ chatId, userId }: ConversationId): ContextEngine {
    return new ContextEngine({ store: this.#store, chatId, userId });
  }

  #mailboxInputMessage(
    communication: InterAgentCommunication,
  ): UIMessage & { role: 'user' } {
    return {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [
        {
          type: 'text',
          text: this.#renderInterAgentCommunication(communication),
        },
      ],
      metadata: { interAgentCommunication: communication },
    };
  }

  #renderInterAgentCommunication(
    communication: InterAgentCommunication,
  ): string {
    const recipientPath = communication.metadata?.recipientPath;
    const authorPath = communication.metadata?.authorPath;
    const taskName =
      typeof recipientPath === 'string'
        ? recipientPath
        : communication.recipient.chatId;
    const sender =
      typeof authorPath === 'string' ? authorPath : communication.author.chatId;
    return `Message Type: ${communication.type}\nTask name: ${taskName}\nSender: ${sender}\nPayload:\n${communication.content}`;
  }
}

function readElements(
  metadata: Record<string, unknown> | undefined,
): ElementDescriptor[] | undefined {
  const zukhruf = metadata?.zukhruf;
  if (!isRecord(zukhruf) || !Object.hasOwn(zukhruf, 'elements')) {
    return undefined;
  }
  const parsed = elementsSchema.safeParse(zukhruf.elements);
  if (!parsed.success || parsed.data === undefined) {
    throw new Error('AgentRuntime: stored element catalog is invalid');
  }
  return parsed.data;
}

function readSkills(
  metadata: Record<string, unknown> | undefined,
): readonly AvailableSkill[] | undefined {
  const zukhruf = metadata?.zukhruf;
  if (!isRecord(zukhruf) || !Object.hasOwn(zukhruf, 'skills')) {
    return undefined;
  }
  if (!Array.isArray(zukhruf.skills) || !zukhruf.skills.every(isSkill)) {
    throw new Error('AgentRuntime: stored skill catalog is invalid');
  }
  return zukhruf.skills;
}

function isSkill(value: unknown): value is AvailableSkill {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.path === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
