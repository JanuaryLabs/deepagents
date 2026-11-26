import {
  type UIMessage,
  type UIMessageStreamWriter,
  jsonSchema,
  tool,
} from 'ai';
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
  collectExplicitSkillMentions,
  isRecord,
  role,
  user,
  verbatim,
} from '@deepagents/context';
import { type ElementDescriptor, elementsSchema } from '@deepagents/elements';
import {
  elementsFragment,
  elementsStreamTransform,
} from '@deepagents/elements/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../agent.ts';
import type { AgentToolContext } from '../collaboration/agent-tool-context.ts';
import type { Team } from '../collaboration/team.ts';
import type { AgentControlPlane } from '../control-plane/agent-control-plane.ts';
import type { AgentThread } from '../control-plane/agent-thread.ts';
import type { MailboxCoordinator } from '../mailbox/coordinator.ts';
import type {
  ConversationId,
  InterAgentCommunication,
} from '../mailbox/types.ts';
import type { ConsumeContext, TurnRef } from '../queue/turn-queue.ts';
import type { AgentPluginToolContext } from './agent-runtime.ts';
import type { ApprovalController } from './approval-controller.ts';
import { createCompaction } from './compaction.ts';
import type { ConversationSandboxes } from './conversation-sandboxes.ts';
import {
  type AgentSkills,
  type SkillPrompts,
  createAgentSkills,
  discoverAgentSkills,
  loadSkillPrompts,
} from './plugin/agent-skills.ts';
import type { PluginManager } from './plugin/plugin-manager.ts';
import type { SandboxIdleStop } from './sandbox-idle-stop.ts';
import type { TurnSettlement } from './turn-settlement.ts';

type TurnPlugins = Pick<
  PluginManager,
  'tools' | 'skillsByAgent' | 'runtimeContext' | 'configureTelemetry'
>;

export interface AgentTurnExecutorOptions {
  store: ContextStore;
  streams: StreamManager;
  controlPlane: AgentControlPlane;
  mailbox: MailboxCoordinator;
  approvals: ApprovalController;
  team: Team;
  plugins: TurnPlugins;
  /** The sandbox of each conversation, which a turn borrows. */
  sandboxes: ConversationSandboxes;
  /** Cancels the idle stop of a chat's previous turn as its next turn starts; none when no agent stops idle sandboxes. */
  idleStop: SandboxIdleStop | undefined;
  /** Completes every delivery that does not park, recording its settle intents. */
  settlement: Pick<TurnSettlement, 'complete' | 'completeEmptyWake'>;
  /** Signals that the conversation's status may have changed. Never rejects. */
  publishConversationStatus: (conversation: ConversationId) => Promise<void>;
  /** Whether the tree `thread` is in is archived. */
  inArchivedTree: (thread: AgentThread) => Promise<boolean>;
  /** Revives the chat's parked turns. */
  resumeParked: (chatId: string) => Promise<void>;
}

/** How a delivery that did not park ends: a mailbox wake that found no mail completes its stream itself. */
type TurnEnd = 'settled' | 'empty-wake';

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
  readonly #team: Team;
  readonly #plugins: TurnPlugins;
  readonly #sandboxes: ConversationSandboxes;
  readonly #idleStop: SandboxIdleStop | undefined;
  readonly #settlement: AgentTurnExecutorOptions['settlement'];
  readonly #publishConversationStatus: AgentTurnExecutorOptions['publishConversationStatus'];
  readonly #inArchivedTree: AgentTurnExecutorOptions['inArchivedTree'];
  readonly #resumeParked: AgentTurnExecutorOptions['resumeParked'];

  constructor(options: AgentTurnExecutorOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#controlPlane = options.controlPlane;
    this.#mailbox = options.mailbox;
    this.#approvals = options.approvals;
    this.#team = options.team;
    this.#plugins = options.plugins;
    this.#sandboxes = options.sandboxes;
    this.#idleStop = options.idleStop;
    this.#settlement = options.settlement;
    this.#publishConversationStatus = options.publishConversationStatus;
    this.#inArchivedTree = options.inArchivedTree;
    this.#resumeParked = options.resumeParked;
  }

  /**
   * Runs the turn, then completes every delivery that does not park, the
   * redelivery of a terminal turn included, in one admission that records
   * its settle intents. A parked turn records none: it has not settled.
   */
  async execute(turn: TurnRef, context: ConsumeContext): Promise<void> {
    if (turn.kind === 'recovery') {
      await this.#reopen(turn.streamId);
    }
    if (await this.#projectSkippedTerminalTurn(turn)) {
      await this.#settlement.complete(turn);
      return;
    }

    let parked = false;
    await this.#mailbox.beginTurn(turn);
    try {
      const end = await this.#executeTurn(turn, {
        ...context,
        park: async () => {
          parked = true;
          await context.park();
          // A parked turn never settles through the queue, so its
          // "waiting on approval" status is published here.
          await this.#publishConversationStatus(turn);
        },
      });
      if (!parked) {
        await (end === 'empty-wake'
          ? this.#settlement.completeEmptyWake(turn)
          : this.#settlement.complete(turn));
      }
    } finally {
      await this.#mailbox.endTurn(turn, { parked });
    }
  }

  async #executeTurn(
    turn: TurnRef,
    { signal, park }: ConsumeContext,
  ): Promise<TurnEnd> {
    if (await this.#projectSkippedTerminalTurn(turn)) return 'settled';

    const { declaration, thread } = await this.#controlPlane.resolve(turn);
    // A turn of an archived tree that was queued before the archive waits,
    // parked, for its unarchive; mail still runs, as collaboration resumes
    // an archived agent.
    if (turn.kind === 'message' && (await this.#inArchivedTree(thread))) {
      await park();
      // An unarchive that cleared the mark after the check above ran its
      // resumeParked while this job was still active, which revives nothing;
      // so a mark found cleared once the park has landed is resumed here.
      // `thread` is the state read before the park: a fresh read decides.
      const { thread: current } = await this.#controlPlane.resolve(turn);
      if (!(await this.#inArchivedTree(current))) {
        await this.#resumeParked(turn.chatId);
      }
      return 'settled';
    }
    const usageHint = this.#team.guidance(
      thread.path.isRoot ? 'root' : 'subagent',
    );
    const engine = this.#engineFor(turn).set(
      ...declaration.instructions,
      ...(usageHint === undefined ? [] : [role(usageHint)]),
      verbatim(this.#team.multiAgentModeMessage),
    );

    if (
      (turn.kind === 'message' && turn.message.role === 'user') ||
      turn.kind === 'mailbox'
    ) {
      const head = (await engine.getMessages()).at(-1);
      if (this.#approvals.isPaused(head)) {
        await park();
        return 'settled';
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
      return 'empty-wake';
    }

    // `thread` still names the previous turn as the latest until this records.
    await this.#idleStop?.cancel(thread);
    await this.#controlPlane.recordLatestTurn(turn, turn.streamId);

    const { sandbox, agentSkills, skillPrompts } = await this.#loadSkills(
      turn,
      declaration,
      signal,
    ).catch(async (error: unknown) => {
      // Codex records the turn's input before it loads skills, so a turn
      // whose setup fails still holds its message.
      await this.#prepareChain(turn, engine, communications, []);
      throw error;
    });
    await this.#prepareChain(
      turn,
      engine,
      communications,
      skillPrompts.prompts,
    );
    engine.set(...agentSkills.fragments);
    const warnings = [
      ...(agentSkills.warning === undefined ? [] : [agentSkills.warning]),
      ...skillPrompts.warnings,
    ];
    const elements = await this.#elementsFor(turn);
    if (elements.length > 0) {
      engine.set(elementsFragment(elements));
    }

    if (await this.#projectSkippedTerminalTurn(turn)) return 'settled';
    if (!(await this.#streams.claim(turn.streamId))) {
      await this.#projectSkippedTerminalTurn(turn);
      return 'settled';
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
      reasoning: declaration.reasoning,
      maxOutputTokens: declaration.maxOutputTokens,
      timeout: declaration.timeout,
      stopWhen: declaration.stopWhen,
      toolCallConcurrency: declaration.toolCallConcurrency,
      experimental_toolApprovalSecret:
        declaration.experimental_toolApprovalSecret,
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
      experimental_toolCallers: this.#team.surface.toolCallers,
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
      ...this.#team.surface.tools,
      ...this.#plugins.tools,
    };
    const toolsContext = {
      ...this.#team.contextFor(agentContext),
      ...Object.fromEntries(
        Object.keys(this.#plugins.tools).map((name) => [name, pluginContext]),
      ),
    };

    const abort = new AbortController();
    const turnSignal = AbortSignal.any([signal, abort.signal]);
    let writer: UIMessageStreamWriter;
    const compaction = declaration.compaction
      ? createCompaction<
          ReturnType<
            typeof agent<typeof modelTools, ZukhrufSandbox['tools']>
          >['tools']
        >(declaration.compaction, engine, this.#store, turnSignal, (data) =>
          writer.write({
            type: 'data-compaction',
            id: `${data.id}:${data.status}`,
            data,
          }),
        )
      : undefined;
    const { toolApproval } = declaration;
    const stream = await chat(
      agent({
        ...agentOptions,
        tools: modelTools,
        // The declaration's dynamic policy also sees injected runtime tools;
        // the call re-types it for this turn's tool set.
        toolApproval:
          typeof toolApproval === 'function'
            ? (options) => toolApproval(options)
            : toolApproval,
        prepareStep: compaction?.prepareStep,
      }),
      {
        onStream: (streamWriter) => {
          writer = streamWriter;
          for (const message of warnings) {
            writer.write({ type: 'data-warning', data: { message } });
          }
        },
        abortSignal: turnSignal,
        onStart: compaction?.onStart,
        onStepStart: compaction?.onStepStart,
        onStepEnd: compaction?.onStepEnd,
        include: compaction?.include,
        toolsContext,
        ...(elements.length > 0
          ? { transform: [elementsStreamTransform] }
          : {}),
      },
    );
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
    return 'settled';
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

  /**
   * Record the turn's input, then one user message per `<skill>` prompt after
   * the user message, as Codex records them (`core/src/session/turn.rs`), so
   * the skills stay in history.
   */
  async #prepareChain(
    turn: TurnRef,
    engine: ContextEngine,
    communications: InterAgentCommunication[],
    skillPrompts: SkillPrompts['prompts'],
  ): Promise<void> {
    const skillMessages = skillPrompts.map(({ name, path, text }) =>
      user({
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
        metadata: { skillInstructions: { name, path } },
      }),
    );
    if (turn.kind === 'message') {
      if (turn.message.role === 'assistant') {
        await engine.continue(assistant(turn.message));
      } else if (turn.trigger === 'regenerate-message') {
        await engine.rewind(turn.message.id);
        engine.set(
          ...skillMessages,
          assistant({ id: turn.streamId, role: 'assistant', parts: [] }),
        );
        await engine.save({ branch: false });
      } else {
        engine.set(
          ...communications.map((communication) =>
            user(this.#mailboxInputMessage(communication)),
          ),
          user(turn.message),
          ...skillMessages,
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

  /** The turn's sandbox, the agent's skills, and the skills the user's message mentions, read for injection. */
  async #loadSkills(
    turn: TurnRef,
    declaration: AgentDeclaration,
    signal: AbortSignal,
  ): Promise<{
    sandbox: ZukhrufSandbox;
    agentSkills: AgentSkills;
    skillPrompts: SkillPrompts;
  }> {
    const sandbox = await this.#sandboxes.acquire(declaration, {
      chatId: turn.chatId,
      userId: turn.userId,
    });
    const agentSkills = await this.#skillsFor(
      turn,
      declaration.name,
      sandbox,
      signal,
    );
    const mentioned =
      turn.kind === 'message' &&
      turn.message.role === 'user' &&
      !this.#controlPlane.isSpawnTask(turn, turn.message)
        ? collectExplicitSkillMentions(
            turn.message.parts.flatMap((part) =>
              part.type === 'text' ? [part.text] : [],
            ),
            agentSkills.available,
          )
        : [];
    return {
      sandbox,
      agentSkills,
      skillPrompts: await loadSkillPrompts(agentSkills, mentioned, sandbox),
    };
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

    let available: readonly AvailableSkill[] = await discoverAgentSkills(
      sandbox,
      signal,
    );
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
      return createAgentSkills(available, []);
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
    await Promise.all(
      pluginSkills.files.map(({ path: relativePath, content }) =>
        sandbox.sandbox.writeBinaryFile({
          path: path.posix.join(workingDirectory, relativePath),
          content,
        }),
      ),
    );
    return createAgentSkills(available, pluginSkills.available);
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
