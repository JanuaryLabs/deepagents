import type { UIMessage } from 'ai';

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

import type { ZukhrufSandbox } from '../agent.ts';
import type {
  AgentToolContext,
  SchedulingToolContext,
} from '../collaboration/agent-tool-context.ts';
import { createCollaborationTools } from '../collaboration/collaboration-tools.ts';
import type { AgentControlPlane } from '../control-plane/agent-control-plane.ts';
import type { MailboxCoordinator } from '../mailbox/coordinator.ts';
import type {
  ConversationId,
  InterAgentCommunication,
} from '../mailbox/types.ts';
import type { ResolvedMultiAgentHostConfig } from '../multi-agent-config.ts';
import type { ConsumeContext, TurnRef } from '../queue/turn-queue.ts';
import type { SchedulingCoordinator } from '../scheduling/coordinator.ts';
import { schedulingTools } from '../scheduling/tools.ts';
import {
  type AgentSkills,
  createAgentSkills,
  discoverAgentSkills,
} from './agent-skills.ts';
import type { ApprovalController } from './approval-controller.ts';

export interface AgentTurnExecutorOptions {
  store: ContextStore;
  streams: StreamManager;
  controlPlane: AgentControlPlane;
  mailbox: MailboxCoordinator;
  approvals: ApprovalController;
  multiAgent: ResolvedMultiAgentHostConfig;
  scheduling?: SchedulingCoordinator;
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
  readonly #collaborationTools: ReturnType<typeof createCollaborationTools>;
  readonly #scheduling?: SchedulingCoordinator;

  constructor(options: AgentTurnExecutorOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#controlPlane = options.controlPlane;
    this.#mailbox = options.mailbox;
    this.#approvals = options.approvals;
    this.#multiAgent = options.multiAgent;
    this.#collaborationTools = createCollaborationTools(options.multiAgent);
    this.#scheduling = options.scheduling;
  }

  async execute(turn: TurnRef, context: ConsumeContext): Promise<void> {
    if (turn.kind === 'approval') {
      if (!(await this.#approvals.applyDecision(turn))) return;
      await this.#reopen(turn.streamId);
      return this.execute(
        {
          kind: 'continuation',
          streamId: turn.streamId,
          chatId: turn.chatId,
          userId: turn.userId,
        },
        context,
      );
    }
    if (turn.kind === 'continuation' && turn.recovery !== undefined) {
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

    if (turn.kind === 'ask' || turn.kind === 'mailbox') {
      const head = (await engine.getMessages()).at(-1);
      if (this.#approvals.isPaused(head)) {
        await park();
        return;
      }
    }

    let communications: InterAgentCommunication[] = [];
    if (turn.kind === 'ask') {
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
    const agentSkills = await this.#skillsFor(turn, sandbox, signal);
    engine.set(...agentSkills.fragments);

    if (await this.#projectSkippedTerminalTurn(turn)) return;
    if (!(await this.#streams.claim(turn.streamId))) {
      await this.#projectSkippedTerminalTurn(turn);
      return;
    }
    const agentContext = {
      controlPlane: this.#controlPlane,
      actor: { turn, thread, declaration },
    } satisfies AgentToolContext;
    const mailboxState: SamplingMailboxState = { firstRequest: true };
    const agentOptions = {
      name: declaration.name,
      model: declaration.model,
      sandbox,
      context: engine,
      telemetry: declaration.telemetry,
      prepareStepInput: () => this.#prepareStepInput(turn, mailboxState),
    };
    const modelTools = {
      ...declaration.tools,
      ...this.#collaborationTools,
    };
    const collaborationToolsContext = {
      spawn_agent: agentContext,
      send_message: agentContext,
      followup_task: agentContext,
      list_agents: agentContext,
      wait_agent: agentContext,
      interrupt_agent: agentContext,
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
        if (this.#scheduling === undefined) {
          stream = await chat(
            agent({
              ...agentOptions,
              tools: modelTools,
            }),
            {
              abortSignal: abort.signal,
              toolsContext: collaborationToolsContext,
            },
          );
        } else {
          const scheduledModelTools = { ...modelTools, ...schedulingTools };
          const schedulingContext = {
            ...agentContext,
            schedulingCoordinator: this.#scheduling,
          } satisfies SchedulingToolContext;
          stream = await chat(
            agent({
              ...agentOptions,
              tools: scheduledModelTools,
            }),
            {
              abortSignal: abort.signal,
              toolsContext: {
                ...collaborationToolsContext,
                CronCreate: schedulingContext,
                CronList: schedulingContext,
                CronDelete: schedulingContext,
                ScheduleWakeup: schedulingContext,
              },
            },
          );
        }
      } finally {
        await setupCancellation[Symbol.asyncDispose]();
      }
      await this.#streams.persist(stream, turn.streamId, {
        preclaimed: true,
        onCancelDetected: () => abort.abort(),
      });
      if (turn.kind === 'continuation') {
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

    if (turn.kind === 'continuation') {
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
    if (turn.kind === 'ask') {
      engine.set(
        ...communications.map((communication) =>
          user(this.#mailboxInputMessage(communication)),
        ),
        this.#askInputMessage(turn),
        assistant({ id: turn.streamId, role: 'assistant', parts: [] }),
      );
      await engine.save({ branch: true });
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
      turn.kind === 'ask' && state.firstRequest
        ? await this.#mailbox.drainLeadingQueueOnly(turn)
        : await this.#mailbox.drain(turn);
    state.firstRequest = false;
    return communications.length === 0
      ? undefined
      : communications.map((communication) =>
          this.#mailboxInputMessage(communication),
        );
  }

  async #skillsFor(
    turn: TurnRef,
    sandbox: ZukhrufSandbox,
    signal: AbortSignal,
  ): Promise<AgentSkills> {
    const chat = await this.#store.getChat(turn.chatId);
    const existing = readSkills(chat?.metadata);
    if (existing !== undefined) return createAgentSkills(existing);
    if (sandbox.workingDirectory === undefined) return createAgentSkills([]);

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
    return available === discovered.available
      ? discovered
      : createAgentSkills(available);
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

  #askInputMessage(
    turn: Extract<TurnRef, { kind: 'ask' }>,
  ): ReturnType<typeof user> {
    if (turn.origin !== 'scheduled') {
      return user(turn.input);
    }
    return user({
      id: turn.schedule.occurrenceId,
      role: 'user',
      parts: [{ type: 'text', text: turn.input }],
      metadata: {
        zukhruf: {
          origin: 'scheduled',
          schedule: turn.schedule,
        },
      },
    });
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
