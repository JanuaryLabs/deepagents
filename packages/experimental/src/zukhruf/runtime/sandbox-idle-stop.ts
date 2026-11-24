import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import type { StreamStore } from '@deepagents/context';

import type {
  StoppableSandboxDeclaration,
  ZukhrufSandboxDeclaration,
} from '../agent.ts';
import type { AgentDeclarationRegistry } from '../control-plane/agent-declaration-registry.ts';
import type { AgentDirectory } from '../control-plane/agent-directory.ts';
import type { AgentResidency } from '../control-plane/agent-residency.ts';
import type { AgentThread } from '../control-plane/agent-thread.ts';
import { conversationNamespace } from '../control-plane/agent-turn-id.ts';
import type { ConversationId } from '../mailbox/types.ts';
import type { Wake, WakeScheduler } from '../queue/wake-scheduler.ts';
import type { SandboxIdleWake } from '../sandbox/sandbox-idle-wake.ts';
import {
  type ConversationStatusProjector,
  conversationStatusOf,
} from './conversation-status/projector.ts';

const sandboxIdleWakeSchema: z.ZodType<SandboxIdleWake> = z
  .object({
    conversation: z
      .object({ chatId: z.string().min(1), userId: z.string().min(1) })
      .strict(),
    turnId: z.string().min(1).nullable(),
    scheduledFor: z.number().int().nonnegative(),
  })
  .strict();

/** A declaration whose sandboxes stop after a number of idle milliseconds. */
type IdleStoppingSandbox = StoppableSandboxDeclaration & {
  readonly idleTimeoutMs: number;
};

function stopsWhenIdle(
  sandbox: ZukhrufSandboxDeclaration,
): sandbox is IdleStoppingSandbox {
  return typeof sandbox.idleTimeoutMs === 'number';
}

export interface SandboxIdleStopOptions {
  wakes: WakeScheduler<SandboxIdleWake>;
  declarations: AgentDeclarationRegistry;
  directory: AgentDirectory;
  streams: StreamStore;
  residency: AgentResidency;
  conversationStatus: ConversationStatusProjector;
}

/**
 * Stops a chat's sandbox once the chat has been idle for its declaration's
 * `idleTimeoutMs`, keeping its files: the next turn's resume starts it again.
 * The stop is a wake armed when a turn settles and the chat is idle, at the
 * turn's finish plus the idle time; when it fires, the chat is checked again
 * inside its tree's admission, so no turn can be pushed between the check
 * and the stop.
 */
export class SandboxIdleStop {
  readonly #wakes: WakeScheduler<SandboxIdleWake>;
  readonly #declarations: AgentDeclarationRegistry;
  readonly #directory: AgentDirectory;
  readonly #streams: StreamStore;
  readonly #residency: AgentResidency;
  readonly #conversationStatus: ConversationStatusProjector;

  constructor(options: SandboxIdleStopOptions) {
    this.#wakes = options.wakes;
    this.#declarations = options.declarations;
    this.#directory = options.directory;
    this.#streams = options.streams;
    this.#residency = options.residency;
    this.#conversationStatus = options.conversationStatus;
  }

  /** Whether any agent of the tree stops its sandboxes after an idle time. */
  get stopsIdleSandboxes(): boolean {
    return this.#declarations
      .values()
      .some(({ sandbox }) => stopsWhenIdle(sandbox));
  }

  /** Arms the chat's stop when the chat is idle after its latest turn. */
  async arm(conversation: ConversationId): Promise<void> {
    const thread = await this.#directory.load(conversation);
    if (thread?.lastTurnId === undefined) return;
    const sandbox = this.#idleStoppingSandbox(thread);
    if (!sandbox) return;
    if ((await this.#conversationStatus.read(conversation)).type === 'active') {
      return;
    }
    const stream = await this.#streams.getStream(thread.lastTurnId);
    if (typeof stream?.finishedAt !== 'number') {
      throw new Error(
        `SandboxIdleStop: the latest turn "${thread.lastTurnId}" of idle chat "${conversation.chatId}" has not finished`,
      );
    }
    const scheduledFor = stream.finishedAt + sandbox.idleTimeoutMs;
    await this.#wakes.schedule(
      this.#toWake({
        conversation: thread.conversation,
        turnId: thread.lastTurnId,
        scheduledFor,
      }),
    );
  }

  /**
   * Cancels the stop armed for the thread's latest turn, as the chat's next
   * turn starts. It never rejects, so the turn runs: a failure is a process
   * warning, and a stop still delivered finds the chat active or on a later
   * turn and does nothing.
   */
  async cancel(thread: AgentThread): Promise<void> {
    const turnId = thread.lastTurnId;
    if (turnId === undefined) return;
    const sandbox = this.#idleStoppingSandbox(thread);
    if (!sandbox) return;
    try {
      const stream = await this.#streams.getStream(turnId);
      if (typeof stream?.finishedAt !== 'number') return;
      await this.#wakes.cancel(
        this.#wakeId({
          conversation: thread.conversation,
          turnId,
          scheduledFor: stream.finishedAt + sandbox.idleTimeoutMs,
        }),
      );
    } catch (error) {
      process.emitWarning(
        new Error(
          `SandboxIdleStop: cancelling the stop of chat "${thread.conversation.chatId}" armed for turn "${turnId}" failed: ${Error.isError(error) ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  }

  /**
   * Arms the chat's stop as a plugin borrows its sandbox outside a turn,
   * which can start it: idleTimeoutMs from now, when the chat is idle, keyed
   * on its latest turn (none before the first), in place of the stop that
   * turn armed when it settled. It never rejects, so the borrow succeeds: a
   * failure is a process warning, and the sandbox then stops on the next
   * turn's window instead.
   */
  async armAfterBorrow(conversation: ConversationId): Promise<void> {
    const { chatId, userId } = conversation;
    try {
      const thread = await this.#directory.load(conversation);
      const sandbox = this.#idleStoppingSandbox(thread);
      if (!sandbox) return;
      const status = await this.#conversationStatus.read(conversation);
      if (status.type === 'active') return;
      if (thread) await this.cancel(thread);
      await this.#wakes.schedule(
        this.#toWake({
          conversation: { chatId, userId },
          turnId: thread?.lastTurnId ?? null,
          scheduledFor: Date.now() + sandbox.idleTimeoutMs,
        }),
      );
    } catch (error) {
      process.emitWarning(
        new Error(
          `SandboxIdleStop: arming the stop of chat "${chatId}" after a plugin borrowed its sandbox failed: ${Error.isError(error) ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  }

  work(): Promise<AsyncDisposable> {
    return this.#wakes.consume((wake) => this.#handle(wake));
  }

  async #handle(raw: Wake<SandboxIdleWake>): Promise<void> {
    const wake = sandboxIdleWakeSchema.parse(raw.data);
    if (raw.runAt.getTime() !== wake.scheduledFor) {
      throw new Error('Sandbox idle wake due time does not match its payload');
    }
    if (raw.id !== this.#wakeId(wake)) {
      throw new Error(
        `Sandbox idle wake id "${raw.id}" does not match its payload`,
      );
    }
    const thread = await this.#directory.load(wake.conversation);
    const sandbox = this.#idleStoppingSandbox(thread);
    if (!sandbox) return;
    await this.#residency.admit(
      thread ?? wake.conversation,
      async (admission) => {
        const current = await admission.directory.load(wake.conversation);
        if ((current?.lastTurnId ?? null) !== wake.turnId) return;
        const status = await conversationStatusOf(admission, wake.conversation);
        if (status.type === 'active') return;
        await sandbox.environment.stop(wake.conversation);
      },
    );
  }

  /**
   * The sandbox of the chat's agent when it stops after an idle time. A chat
   * with no thread yet has only the root's, which a plugin borrow opens.
   */
  #idleStoppingSandbox(
    thread: AgentThread | undefined,
  ): IdleStoppingSandbox | undefined {
    const declaration = thread
      ? this.#declarations.get(thread.declarationName)
      : this.#declarations.root;
    const sandbox = declaration?.sandbox;
    return sandbox && stopsWhenIdle(sandbox) ? sandbox : undefined;
  }

  #toWake(data: SandboxIdleWake): Wake<SandboxIdleWake> {
    return { id: this.#wakeId(data), runAt: new Date(data.scheduledFor), data };
  }

  #wakeId(wake: SandboxIdleWake): string {
    return uuidv5(
      JSON.stringify(['sandbox-idle', wake.turnId, wake.scheduledFor]),
      conversationNamespace(wake.conversation),
    );
  }
}
