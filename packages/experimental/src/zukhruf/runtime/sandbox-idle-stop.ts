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
import { NonRetryableError } from '../non-retryable-error.ts';
import type { Wake, WakeScheduler } from '../queue/wake-scheduler.ts';
import type { SandboxIdleWake } from '../sandbox/sandbox-idle-wake.ts';
import type { AdmissionScope } from '../storage/agent-storage.ts';
import {
  type ConversationStatusProjector,
  conversationStatusOf,
} from './conversation-status/projector.ts';
import type { SettleFollowUp } from './turn-settlement.ts';

const sandboxIdleWakeSchema: z.ZodType<SandboxIdleWake> = z
  .object({
    conversation: z
      .object({ chatId: z.string().min(1), userId: z.string().min(1) })
      .strict(),
    turnId: z.string().min(1).nullable(),
    scheduledFor: z.number().int().nonnegative(),
  })
  .strict();

function stoppable(
  sandbox: ZukhrufSandboxDeclaration,
): sandbox is StoppableSandboxDeclaration {
  return sandbox.idleTimeoutMs !== undefined;
}

/**
 * Milliseconds the sandbox keeps running once its chat is idle: none while
 * the chat is archived, else its declaration's, where `false` never stops it.
 */
function idleTimeOf(
  thread: AgentThread,
  sandbox: StoppableSandboxDeclaration,
): number | false {
  return thread.archivedAt === undefined ? sandbox.idleTimeoutMs : 0;
}

/** An idle chat's latest turn has no finish time: its stream contradicts the chat's status, which no retry changes. */
export class UnfinishedIdleTurnError extends NonRetryableError {
  override readonly name = 'UnfinishedIdleTurnError';
}

/** Cancelling a chat's armed idle stop failed as its next turn started; a late stop finds the chat busy and does nothing. */
class IdleStopCancelWarning extends Error {
  readonly code = 'DEEPAGENTS_ZUKHRUF_IDLE_STOP_CANCEL_FAILED';
  readonly detail: string;

  constructor(failure: unknown, conversation: ConversationId, turnId: string) {
    super(
      `Cancelling a chat's idle stop failed, and a late stop finds the chat busy and does nothing: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'IdleStopCancelWarning';
    this.detail = `chat: ${conversation.chatId}, turn: ${turnId}`;
  }
}

/** Arming a chat's idle stop after a plugin borrowed its sandbox failed; the next turn's window stops it instead. */
class IdleStopArmWarning extends Error {
  readonly code = 'DEEPAGENTS_ZUKHRUF_IDLE_STOP_ARM_FAILED';
  readonly detail: string;

  constructor(failure: unknown, conversation: ConversationId) {
    super(
      `Arming a chat's idle stop after a plugin borrowed its sandbox failed, and the next turn's window stops it instead: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'IdleStopArmWarning';
    this.detail = `chat: ${conversation.chatId}`;
  }
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
 * Stops a chat's sandbox once the chat has been idle for its idle time,
 * keeping its files: the next turn's resume starts it again. The idle time is
 * the declaration's `idleTimeoutMs`, and none while the chat is archived. The
 * stop is a wake armed by this settle follow-up once a turn has settled and
 * the chat is idle, at the turn's finish plus the idle time, or by the
 * archive itself; when it fires, the chat is checked again inside its tree's
 * admission, so no turn can be pushed between the check and the stop. A
 * runtime has one only when an agent of its tree has a sandbox that can stop.
 */
export class SandboxIdleStop implements SettleFollowUp {
  readonly name = 'sandbox-idle-stop';
  readonly #wakes: WakeScheduler<SandboxIdleWake>;
  readonly #declarations: AgentDeclarationRegistry;
  readonly #directory: AgentDirectory;
  readonly #streams: StreamStore;
  readonly #residency: AgentResidency;
  readonly #conversationStatus: ConversationStatusProjector;

  private constructor(options: SandboxIdleStopOptions) {
    this.#wakes = options.wakes;
    this.#declarations = options.declarations;
    this.#directory = options.directory;
    this.#streams = options.streams;
    this.#residency = options.residency;
    this.#conversationStatus = options.conversationStatus;
  }

  /** The idle stop of the tree's agents, or none when no agent's sandbox can stop. */
  static of(options: SandboxIdleStopOptions): SandboxIdleStop | undefined {
    return options.declarations
      .values()
      .some(({ sandbox }) => stoppable(sandbox))
      ? new SandboxIdleStop(options)
      : undefined;
  }

  /** Arms the chat's stop when the chat is idle after its latest turn. */
  async run(conversation: ConversationId): Promise<void> {
    const thread = await this.#directory.load(conversation);
    if (thread?.lastTurnId === undefined) return;
    const sandbox = this.#stoppableSandbox(thread);
    if (!sandbox) return;
    const idleTime = idleTimeOf(thread, sandbox);
    if (idleTime === false) return;
    if ((await this.#conversationStatus.read(conversation)).type === 'active') {
      return;
    }
    const stream = await this.#streams.getStream(thread.lastTurnId);
    if (typeof stream?.finishedAt !== 'number') {
      throw new UnfinishedIdleTurnError(
        `SandboxIdleStop: the latest turn "${thread.lastTurnId}" of idle chat "${conversation.chatId}" has not finished`,
      );
    }
    const scheduledFor = stream.finishedAt + idleTime;
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
    const sandbox = this.#stoppableSandbox(thread);
    if (!sandbox) return;
    const idleTime = idleTimeOf(thread, sandbox);
    if (idleTime === false) return;
    try {
      const stream = await this.#streams.getStream(turnId);
      if (typeof stream?.finishedAt !== 'number') return;
      await this.#wakes.cancel(
        this.#wakeId({
          conversation: thread.conversation,
          turnId,
          scheduledFor: stream.finishedAt + idleTime,
        }),
      );
    } catch (error) {
      process.emitWarning(
        new IdleStopCancelWarning(error, thread.conversation, turnId),
      );
    }
  }

  /**
   * Arms the chat's stop as a plugin borrows its sandbox outside a turn,
   * which can start it: idleTimeoutMs from now, when the chat is idle, keyed
   * on its latest turn (none before the first), in place of the stop that
   * turn armed when it settled. It never rejects, so the borrow succeeds: a
   * failure is a process warning, and the sandbox then stops on the next
   * turn's window instead. The borrower uses the sandbox after this, so an
   * archived chat's window is its declaration's idle time too.
   */
  async armAfterBorrow(conversation: ConversationId): Promise<void> {
    const { chatId, userId } = conversation;
    try {
      const thread = await this.#directory.load(conversation);
      const sandbox = this.#stoppableSandbox(thread);
      if (!sandbox || sandbox.idleTimeoutMs === false) return;
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
      process.emitWarning(new IdleStopArmWarning(error, conversation));
    }
  }

  /**
   * Schedules the stop of `member`'s sandbox, due at `archivedAt`, in the
   * admission that archives it, keyed on its latest turn: any worker delivers
   * it, and retries a stop that fails. A turn of the member still running is
   * cancelled after the admission; its settle arms the stop again, at once,
   * as an archived chat's idle time is none.
   */
  async archive(
    scope: AdmissionScope,
    member: AgentThread,
    archivedAt: number,
  ): Promise<void> {
    if (!this.#stoppableSandbox(member)) return;
    await scope.sandboxIdleWakes.schedule(
      this.#toWake({
        conversation: member.conversation,
        turnId: member.lastTurnId ?? null,
        scheduledFor: archivedAt,
      }),
    );
  }

  work(): Promise<AsyncDisposable> {
    return this.#wakes.consume((wake) => this.#handle(wake));
  }

  async #handle(raw: Wake<SandboxIdleWake>): Promise<void> {
    const wake = sandboxIdleWakeSchema.parse(raw.data);
    // The id covers the payload's due time; `runAt` does not, since a retried
    // delivery comes later.
    if (raw.id !== this.#wakeId(wake)) {
      throw new Error(
        `Sandbox idle wake id "${raw.id}" does not match its payload`,
      );
    }
    const thread = await this.#directory.load(wake.conversation);
    const sandbox = this.#stoppableSandbox(thread);
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
   * The sandbox of the chat's agent when it can stop. A chat with no thread
   * yet has only the root's, which a plugin borrow opens.
   */
  #stoppableSandbox(
    thread: AgentThread | undefined,
  ): StoppableSandboxDeclaration | undefined {
    const declaration = thread
      ? this.#declarations.get(thread.declarationName)
      : this.#declarations.root;
    const sandbox = declaration?.sandbox;
    return sandbox && stoppable(sandbox) ? sandbox : undefined;
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
