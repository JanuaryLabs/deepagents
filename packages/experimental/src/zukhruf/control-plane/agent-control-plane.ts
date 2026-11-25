import type { UIMessage } from 'ai';
import { v5 as uuidv5 } from 'uuid';

import type { StreamManager } from '@deepagents/context';

import type { AgentDeclaration } from '../agent.ts';
import type { MailboxCoordinator } from '../mailbox/coordinator.ts';
import type {
  ConversationId,
  InterAgentCommunicationType,
  MessageDeliveryMode,
} from '../mailbox/types.ts';
import {
  InterAgentCommunicationTypes,
  MessageDeliveryModes,
  createInterAgentCommunication,
} from '../mailbox/types.ts';
import type { TurnQueue, TurnRef, TurnRequest } from '../queue/turn-queue.ts';
import type { ChildActivity } from '../runtime/conversation-status/child-progress.ts';
import { withChildActivity } from '../runtime/conversation-status/projector.ts';
import { AgentDeclarationRegistry } from './agent-declaration-registry.ts';
import { AgentDirectory } from './agent-directory.ts';
import { AgentHistoryForker } from './agent-history-forker.ts';
import type { AgentResidency } from './agent-residency.ts';
import {
  type AgentStatusProjector,
  type ListedAgent,
} from './agent-status-projector.ts';
import { AgentThreadLimitError } from './agent-thread-limit-error.ts';
import type { AgentThread } from './agent-thread.ts';
import { AgentTurnId } from './agent-turn-id.ts';
import { ConversationArchivedError } from './conversation-archived-error.ts';
import type { ForkTurns } from './fork-turns.ts';
import { StaleTurnError } from './stale-turn-error.ts';
import { TurnNotFoundError } from './turn-not-found-error.ts';

export interface AgentControlPlaneOptions {
  root: AgentDeclaration;
  streams: StreamManager;
  queue: TurnQueue;
  mailbox: MailboxCoordinator;
  declarations: AgentDeclarationRegistry;
  directory: AgentDirectory;
  statusProjector: AgentStatusProjector;
  residency: AgentResidency;
  recordActivity: (
    thread: AgentThread,
    activity: ChildActivity,
  ) => Promise<void>;
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
  readonly #residency: AgentResidency;
  readonly #recordActivity: AgentControlPlaneOptions['recordActivity'];

  constructor(options: AgentControlPlaneOptions) {
    this.#root = options.root;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#mailbox = options.mailbox;
    this.#declarations = options.declarations;
    this.#directory = options.directory;
    this.#statusProjector = options.statusProjector;
    this.#residency = options.residency;
    this.#recordActivity = options.recordActivity;
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
    return this.#residency.admit(conversation, async (admission) => {
      // An archived tree runs no turn of its own: neither a user's nor a plugin's.
      const thread = await admission.directory.load(conversation);
      if (
        thread &&
        (await admission.directory.rootOf(thread))?.archivedAt !== undefined
      ) {
        throw new ConversationArchivedError(conversation.chatId);
      }
      const streamId =
        message.role === 'assistant'
          ? await AgentControlPlane.#continuationStreamId(
              admission.directory,
              conversation,
              message,
            )
          : AgentTurnId.fromRequest(conversation, message.id).toString();

      const continues =
        message.role === 'assistant' || turn.trigger === 'regenerate-message';
      if (continues) {
        const status = await admission.streams.getStreamStatus(streamId);
        if (status === undefined) throw new TurnNotFoundError(streamId);
        if (status === 'queued' || status === 'running') return streamId;
      }
      if (!(await admission.admits(conversation))) {
        throw new AgentThreadLimitError();
      }
      if (continues) {
        await admission.streams.reopenStream(streamId);
      } else {
        await admission.registerStream(streamId);
      }
      await admission.queue.push({
        kind: 'message',
        streamId,
        chatId: conversation.chatId,
        userId: conversation.userId,
        ...turn,
      });
      return streamId;
    });
  }

  static async #continuationStreamId(
    directory: AgentDirectory,
    conversation: ConversationId,
    message: UIMessage,
  ): Promise<string> {
    const streamId = (await directory.load(conversation))?.lastTurnId;
    if (message.id !== streamId) throw new StaleTurnError(message.id);
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

    return this.#residency.admit(actor.thread, async (admission) => {
      const conversation = await AgentControlPlane.#spawnStep(() =>
        admission.directory.childConversation(actor.thread, input.taskName),
      );
      const requestId = AgentControlPlane.#initialTurnId(conversation.chatId);
      const streamId = AgentTurnId.fromRequest(
        conversation,
        requestId,
      ).toString();
      const childPath = actor.thread.path.resolve(input.taskName).toString();
      const status = await admission.streams.getStreamStatus(streamId);
      if (
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled'
      ) {
        throw new Error(
          `spawn_agent: agent path "${childPath}" already finished with status "${status}"`,
        );
      }
      // A retried spawn of a child whose initial turn is still scheduled
      // writes nothing again.
      if (
        status !== undefined &&
        (await admission.queue.getTurnActivity(conversation)) !== 'idle'
      ) {
        return { task_name: childPath };
      }
      if (!(await admission.admits(conversation))) {
        throw new Error('collab spawn failed: agent thread limit reached');
      }

      const child = await AgentControlPlane.#spawnStep(() =>
        admission.directory.createChild({
          parent: actor.thread,
          taskName: input.taskName,
          declarationName: childDeclaration.name,
        }),
      );
      await new AgentHistoryForker(admission.store).fork(
        actor.thread,
        child,
        input.forkTurns,
      );
      const activity: ChildActivity = {
        id: `spawn:${streamId}`,
        type: 'spawn',
        at: Date.now(),
        actorPath: actor.thread.path.toString(),
        targetPath: childPath,
        streamId,
      };
      await admission.store.updateChat(child.conversation.chatId, (chat) => {
        const metadata = withChildActivity(chat.metadata, activity);
        return metadata && { metadata };
      });
      await admission.registerStream(streamId);
      await admission.queue.push({
        kind: 'message',
        streamId,
        chatId: child.conversation.chatId,
        userId: child.conversation.userId,
        message: {
          id: requestId,
          role: 'user',
          parts: [{ type: 'text', text: input.message }],
        },
        trigger: 'submit-message',
      });
      return { task_name: childPath };
    });
  }

  /** Runs one spawn step, naming the tool in an invalid or occupied agent path. */
  static async #spawnStep<T>(step: () => T | Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (Error.isError(error) && error.message.startsWith('agent path ')) {
        throw new Error(`spawn_agent: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  async sendMessage(
    actor: AgentActor,
    input: { target: string; message: string },
  ): Promise<{ target: string }> {
    return this.#deliverAgentMessage(actor, input, {
      type: InterAgentCommunicationTypes.Message,
      mode: MessageDeliveryModes.QueueOnly,
      rejectRoot: false,
    });
  }

  async followupTask(
    actor: AgentActor,
    input: { target: string; message: string },
  ): Promise<{ target: string }> {
    return this.#deliverAgentMessage(actor, input, {
      type: InterAgentCommunicationTypes.NewTask,
      mode: MessageDeliveryModes.TriggerTurn,
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
      throw new Error('root is not a spawned agent');
    }
    if (target.path.equals(actor.thread.path)) {
      throw new Error(
        'an agent cannot interrupt itself; return your result and let the parent interrupt you if needed',
      );
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
      await this.projectTerminal(currentTurn, interruptedThread);
      await this.#queue.cancel(currentTurn.streamId);
      await this.#recordActivity(target, {
        id: `interrupt:${currentTurn.streamId}`,
        type: 'interrupt',
        at: Date.now(),
        actorPath: actor.thread.path.toString(),
        targetPath: target.path.toString(),
        streamId: currentTurn.streamId,
      });
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
    const terminal = await this.#statusProjector.projectTerminal(turn, thread);
    if (!terminal) return;
    await this.#recordActivity(thread, {
      id: `completion:${turn.streamId}`,
      type: 'completion',
      outcome: terminal.status,
      at: terminal.finishedAt ?? Date.now(),
      actorPath: thread.path.toString(),
      targetPath: thread.path.toString(),
      streamId: turn.streamId,
    });
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
      throw new Error("Follow-up tasks can't target the root agent");
    }
    const message = createInterAgentCommunication({
      type: options.type,
      author: actor.thread.conversation,
      recipient: target.conversation,
      content: input.message,
      metadata: {
        authorPath: actor.thread.path.toString(),
        recipientPath: target.path.toString(),
      },
    });
    try {
      await this.#mailbox.deliver(message, options.mode);
    } catch (error) {
      // Codex checks the limit only for mail that starts a turn.
      if (error instanceof AgentThreadLimitError) {
        throw new Error('collab tool failed: agent thread limit reached', {
          cause: error,
        });
      }
      throw error;
    }
    await this.#recordActivity(target.path.isRoot ? actor.thread : target, {
      id: message.id,
      type:
        options.mode === MessageDeliveryModes.TriggerTurn
          ? 'followup'
          : 'message',
      at: Date.now(),
      actorPath: actor.thread.path.toString(),
      targetPath: target.path.toString(),
      streamId: actor.turn.streamId,
    });
    return { target: target.path.toString() };
  }

  static #initialTurnId(chatId: string): string {
    return uuidv5(`urn:deepagents:zukhruf:initial-turn:${chatId}`, uuidv5.URL);
  }
}
