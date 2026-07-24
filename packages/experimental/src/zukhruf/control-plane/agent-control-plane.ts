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
import type { TurnQueue, TurnRef } from '../queue/turn-queue.ts';
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
}

export interface AgentActor {
  turn: TurnRef;
  thread: AgentThread;
  declaration: AgentDeclaration;
}

export interface TurnInput {
  /** Caller-supplied idempotency key; enqueue returns its scoped durable id. */
  id: string;
  input: string;
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

  constructor(options: AgentControlPlaneOptions) {
    this.#root = options.root;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#mailbox = options.mailbox;
    this.#declarations = options.declarations;
    this.#directory = options.directory;
    this.#statusProjector = options.statusProjector;
    this.#historyForker = options.historyForker;
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
    turn: TurnInput,
  ): Promise<string> {
    if (!turn.id.trim()) {
      throw new Error(
        'enqueue: turn id is required — it names the ask, making retries idempotent',
      );
    }
    await this.#directory.assertOwnerIfExists(conversation);
    const streamId = AgentTurnId.fromRequest(conversation, turn.id).toString();
    await this.#streams.register(streamId);
    await this.#queue.push({
      kind: 'ask',
      streamId,
      chatId: conversation.chatId,
      userId: conversation.userId,
      input: turn.input,
    });
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
      id: requestId,
      input: input.message,
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

  static #initialTurnId(chatId: string): string {
    return uuidv5(`urn:deepagents:zukhruf:initial-turn:${chatId}`, uuidv5.URL);
  }
}
