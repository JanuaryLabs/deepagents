import type { UIMessage } from 'ai';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  agent,
  assistant,
  chat,
  user,
} from '@deepagents/context';

import type { AgentControlPlane } from './agent-control-plane.ts';
import type { AgentToolContext } from './agent-tool-context.ts';
import type { ApprovalController } from './approval-controller.ts';
import { listAgentsTool } from './list-agents.ts';
import type { MailboxCoordinator } from './mailbox/coordinator.ts';
import type {
  ConversationId,
  InterAgentCommunication,
} from './mailbox/types.ts';
import { followupTaskTool, sendMessageTool } from './message-tools.ts';
import type { ConsumeContext, TurnRef } from './queue/turn-queue.ts';
import { spawnAgentTool } from './spawn-agent.ts';

export interface AgentTurnExecutorOptions {
  store: ContextStore;
  streams: StreamManager;
  controlPlane: AgentControlPlane;
  mailbox: MailboxCoordinator;
  approvals: ApprovalController;
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

  constructor(options: AgentTurnExecutorOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#controlPlane = options.controlPlane;
    this.#mailbox = options.mailbox;
    this.#approvals = options.approvals;
  }

  async execute(turn: TurnRef, context: ConsumeContext): Promise<void> {
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
    const engine = this.#engineFor(turn).set(...declaration.instructions);

    if (turn.kind === 'ask' || turn.kind === 'mailbox') {
      const head = (await engine.getMessages()).at(-1);
      if (this.#approvals.isPaused(head)) {
        await park();
        return;
      }
    }

    const communications =
      turn.kind === 'ask'
        ? await this.#mailbox.drainLeadingQueueOnly(turn)
        : turn.kind === 'mailbox'
          ? await this.#mailbox.drain(turn)
          : [];

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
    if (await this.#projectSkippedTerminalTurn(turn)) return;
    if (!(await this.#streams.claim(turn.streamId))) {
      await this.#projectSkippedTerminalTurn(turn);
      return;
    }
    const mailboxState: SamplingMailboxState = { firstRequest: true };
    const ai = agent<AgentToolContext>({
      name: declaration.name,
      model: declaration.model,
      sandbox,
      context: engine,
      tools: {
        ...declaration.tools,
        spawn_agent: spawnAgentTool,
        send_message: sendMessageTool,
        followup_task: followupTaskTool,
        list_agents: listAgentsTool,
      },
      telemetry: declaration.telemetry,
      prepareStepInput: () => this.#prepareStepInput(turn, mailboxState),
    });

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
        stream = await chat(ai, {
          abortSignal: abort.signal,
          contextVariables: {
            controlPlane: this.#controlPlane,
            actor: { turn, thread, declaration },
          },
        });
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
        user(turn.input),
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
