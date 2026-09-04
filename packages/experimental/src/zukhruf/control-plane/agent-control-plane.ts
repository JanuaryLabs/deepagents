import type { UIMessage } from 'ai';
import { v5 as uuidv5 } from 'uuid';

import type { StreamManager } from '@deepagents/context';

import type { AgentDeclaration } from '../agent.ts';
import type { MailboxCoordinator } from '../mailbox/coordinator.ts';
import type { ConversationId, MessageDeliveryMode } from '../mailbox/types.ts';
import {
  MessageDeliveryMode as DeliveryMode,
  InterAgentCommunicationType,
  createInterAgentCommunication,
} from '../mailbox/types.ts';
import type { TurnQueue, TurnRef, TurnRequest } from '../queue/turn-queue.ts';
import { AgentDeclarationRegistry } from './agent-declaration-registry.ts';
import { AgentDirectory } from './agent-directory.ts';
import { AgentHistoryForker } from './agent-history-forker.ts';
import {
  type AgentStatusProjector,
  type ListedAgent,
} from './agent-status-projector.ts';
import type { AgentThread } from './agent-thread.ts';
import { AgentTurnId } from './agent-turn-id.ts';
import type { ForkTurns } from './fork-turns.ts';

export interface AgentControlPlaneOptions {
  root: AgentDeclaration;
  streams: StreamManager;
  queue: TurnQueue;
  mailbox: MailboxCoordinator;
  declarations: AgentDeclarationRegistry;
  directory: AgentDirectory;
  statusProjector: AgentStatusProjector;
  historyForker: AgentHistoryForker;
  /** Codex `max_concurrent_threads_per_session`, root included. */
  maxConcurrentThreadsPerSession: number;
}

export interface AgentActor {
  turn: TurnRef;
  thread: AgentThread;
  declaration: AgentDeclaration;
}

export interface SpawnAgentInput {
  agentType: string;
  taskName: string;
  message: string;
  forkTurns: ForkTurns;
}

export interface SpawnAgentOutput {
  task_name: string;
}

export type {
  ListedAgent,
  ListedAgentStatus,
} from './agent-status-projector.ts';

/** Application-level coordination for one declared agent tree. */
export class AgentControlPlane {
  readonly #root: AgentDeclaration;
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #mailbox: MailboxCoordinator;
  readonly #declarations: AgentDeclarationRegistry;
  readonly #directory: AgentDirectory;
  readonly #statusProjector: AgentStatusProjector;
  readonly #historyForker: AgentHistoryForker;
  readonly #maxConcurrentThreadsPerSession: number;

  constructor(options: AgentControlPlaneOptions) {
    this.#root = options.root;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#mailbox = options.mailbox;
    this.#declarations = options.declarations;
    this.#directory = options.directory;
    this.#statusProjector = options.statusProjector;
    this.#historyForker = options.historyForker;
    this.#maxConcurrentThreadsPerSession =
      options.maxConcurrentThreadsPerSession;
  }

  async resolve(conversation: ConversationId): Promise<{
    declaration: AgentDeclaration;
    thread: AgentThread;
  }> {
    const thread = await this.#directory.loadOrCreateRoot(
      conversation,
      this.#root.name,
    );
    const declaration = this.#declarations.get(thread.declarationName);
    if (!declaration) {
      throw new Error(
        `AgentControlPlane.resolve: unknown agent declaration "${thread.declarationName}"`,
      );
    }
    return { declaration, thread };
  }

  async enqueue(
    conversation: ConversationId,
    turn: TurnRequest,
  ): Promise<string> {
    const message = turn.message;
    if (!message.id.trim()) throw new Error('enqueue: message id is required');
    await this.#directory.assertOwnerIfExists(conversation);
    // Codex checks capacity on every turn submission of a sub-agent thread
    // that has no turn in flight; the root is never limited.
    const thread = await this.#directory.load(conversation);
    if (
      thread &&
      !thread.path.isRoot &&
      (await this.#queue.getTurnActivity(conversation)) !== 'running' &&
      !(await this.#hasExecutionCapacity(thread))
    ) {
      throw new Error('agent thread limit reached');
    }

    const streamId =
      message.role === 'assistant'
        ? await this.#continuationStreamId(conversation, message)
        : AgentTurnId.fromRequest(conversation, message.id).toString();

    if (message.role === 'assistant' || turn.trigger === 'regenerate-message') {
      const status = await this.#streams.store.getStreamStatus(streamId);
      if (status === undefined)
        throw new Error('enqueue: continuation stream does not exist');
      if (status === 'queued' || status === 'running') return streamId;
      await this.#streams.reopen(streamId);
    } else {
      await this.#streams.register(streamId);
    }

    await this.#queue.push({
      kind: 'message',
      streamId,
      chatId: conversation.chatId,
      userId: conversation.userId,
      ...turn,
    });
    return streamId;
  }

  async #continuationStreamId(
    conversation: ConversationId,
    message: UIMessage,
  ): Promise<string> {
    const streamId = (await this.#directory.load(conversation))?.lastTurnId;
    if (!streamId)
      throw new Error('enqueue: assistant continuation has no previous turn');
    if (message.id !== streamId)
      throw new Error(
        'enqueue: assistant continuation must update the current assistant message',
      );
    return streamId;
  }

  recordLatestTurn(
    conversation: ConversationId,
    streamId: string,
  ): Promise<AgentThread> {
    return this.#directory.recordLatestTurn(conversation, streamId);
  }

  recordLatestTurnIfCurrent(
    conversation: ConversationId,
    streamId: string,
    expectedLastTurnId: string | undefined,
  ): Promise<AgentThread | undefined> {
    return this.#directory.recordLatestTurnIfCurrent(
      conversation,
      streamId,
      expectedLastTurnId,
    );
  }

  async spawn(
    actor: AgentActor,
    input: SpawnAgentInput,
  ): Promise<SpawnAgentOutput> {
    const childDeclaration = (actor.declaration.subagents ?? []).find(
      (subagent) => subagent.name === input.agentType,
    );
    if (!childDeclaration) {
      throw new Error(
        `spawn_agent: agent type "${input.agentType}" is not a subagent of "${actor.declaration.name}"`,
      );
    }
    if (!(await this.#hasExecutionCapacity(actor.thread))) {
      throw new Error('collab spawn failed: agent thread limit reached');
    }

    let child: AgentThread;
    try {
      child = await this.#directory.createChild({
        parent: actor.thread,
        taskName: input.taskName,
        declarationName: childDeclaration.name,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('agent path ')) {
        throw new Error(`spawn_agent: ${error.message}`);
      }
      throw error;
    }

    const childPath = child.path.toString();
    const requestId = AgentControlPlane.#initialTurnId(
      child.conversation.chatId,
    );
    const streamId = AgentTurnId.fromRequest(
      child.conversation,
      requestId,
    ).toString();
    const status = await this.#streams.store.getStreamStatus(streamId);
    if (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
    ) {
      throw new Error(
        `spawn_agent: agent path "${childPath}" already finished with status "${status}"`,
      );
    }
    await this.#historyForker.fork(actor.thread, child, input.forkTurns);
    await this.enqueue(child.conversation, {
      message: {
        id: requestId,
        role: 'user',
        parts: [{ type: 'text', text: input.message }],
      },
      trigger: 'submit-message',
    });
    return { task_name: childPath };
  }

  async sendMessage(
    actor: AgentActor,
    input: { target: string; message: string },
  ): Promise<{ target: string }> {
    return this.#deliverAgentMessage(actor, input, {
      type: InterAgentCommunicationType.Message,
      mode: DeliveryMode.QueueOnly,
      rejectRoot: false,
    });
  }

  async followupTask(
    actor: AgentActor,
    input: { target: string; message: string },
  ): Promise<{ target: string }> {
    return this.#deliverAgentMessage(actor, input, {
      type: InterAgentCommunicationType.NewTask,
      mode: DeliveryMode.TriggerTurn,
      rejectRoot: true,
    });
  }

  async listAgents(
    actor: AgentActor,
    pathPrefix?: string,
  ): Promise<{ agents: ListedAgent[] }> {
    const prefix = pathPrefix
      ? actor.thread.path.resolve(pathPrefix)
      : undefined;
    const threads = await this.#directory.listTree(actor.thread);
    const agents = await Promise.all(
      threads.flatMap((thread) => {
        if (prefix && !prefix.contains(thread.path)) return [];
        return [this.#statusProjector.projectListedAgent(actor.turn, thread)];
      }),
    );
    agents.sort((left, right) =>
      left.agent_name.localeCompare(right.agent_name),
    );
    return { agents };
  }

  async interruptAgent(
    actor: AgentActor,
    input: { target: string },
  ): Promise<{ previous_status: ListedAgent['agent_status'] }> {
    const target = await this.#directory.find(actor.thread, input.target);
    if (!target) return { previous_status: 'not_found' };
    if (target.path.isRoot) {
      throw new Error('interrupt_agent: the root agent cannot be interrupted');
    }
    if (target.path.equals(actor.thread.path)) {
      throw new Error('interrupt_agent: an agent cannot interrupt itself');
    }

    const previous = await this.#statusProjector.projectListedAgent(
      actor.turn,
      target,
    );
    const currentTurn = await this.#queue.getCurrentTurn(target.conversation);
    if (currentTurn) {
      const interruptedThread =
        (await this.#directory.recordLatestTurnIfCurrent(
          target.conversation,
          currentTurn.streamId,
          target.lastTurnId,
        )) ?? target;
      // Stream state is the durable execution authority. Transition it before
      // aborting scheduler delivery so a racing worker observes cancellation,
      // never an orphaned failure.
      await this.#streams.cancel(currentTurn.streamId);
      // Terminal mail has a deterministic id, so retrying this projection is
      // idempotent. Project before destructive queue cleanup: if mailbox
      // delivery fails, the still-discoverable scheduler receipt lets a later
      // interrupt_agent call retry instead of losing FINAL_ANSWER forever.
      await this.#statusProjector.projectTerminal(
        currentTurn,
        interruptedThread,
      );
      await this.#queue.cancel(currentTurn.streamId);
    }
    return { previous_status: previous.agent_status };
  }

  waitForMailbox(
    actor: AgentActor,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<boolean> {
    return this.#mailbox.waitForPending(actor.thread.conversation, options);
  }

  async projectTerminal(turn: TurnRef, thread: AgentThread): Promise<void> {
    await this.#statusProjector.projectTerminal(turn, thread);
  }

  async #deliverAgentMessage(
    actor: AgentActor,
    input: { target: string; message: string },
    options: {
      type: InterAgentCommunicationType;
      mode: MessageDeliveryMode;
      rejectRoot: boolean;
    },
  ): Promise<{ target: string }> {
    const target = await this.#directory.resolve(actor.thread, input.target);
    if (options.rejectRoot && target.path.isRoot) {
      throw new Error(
        'followup_task: the root agent cannot receive a follow-up',
      );
    }
    // Codex checks capacity only for mail that starts a turn, and skips the
    // check when the target already has one in flight.
    if (
      options.mode === DeliveryMode.TriggerTurn &&
      (await this.#queue.getTurnActivity(target.conversation)) !== 'running' &&
      !(await this.#hasExecutionCapacity(actor.thread))
    ) {
      throw new Error('collab tool failed: agent thread limit reached');
    }
    await this.#mailbox.deliver(
      createInterAgentCommunication({
        type: options.type,
        author: actor.thread.conversation,
        recipient: target.conversation,
        content: input.message,
        metadata: {
          authorPath: actor.thread.path.toString(),
          recipientPath: target.path.toString(),
        },
      }),
      options.mode,
    );
    return { target: target.path.toString() };
  }

  /**
   * Codex `AgentExecutionLimiter`: one slot per in-flight sub-agent turn in
   * the tree; the root holds one of the configured slots implicitly, so the
   * cap on sub-agents is the configured total minus one.
   */
  async #hasExecutionCapacity(thread: AgentThread): Promise<boolean> {
    const members = await this.#directory.listTree(thread);
    const activity = await Promise.all(
      members
        .filter((member) => !member.path.isRoot)
        .map((member) => this.#queue.getTurnActivity(member.conversation)),
    );
    const inFlight = activity.filter((state) => state === 'running').length;
    return inFlight < this.#maxConcurrentThreadsPerSession - 1;
  }

  static #initialTurnId(chatId: string): string {
    return uuidv5(`urn:deepagents:zukhruf:initial-turn:${chatId}`, uuidv5.URL);
  }
}
