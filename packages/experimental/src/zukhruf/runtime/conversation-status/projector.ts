import { Future, Latch } from '@zukhruf/async';
import { Mutex } from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';
import type { UIMessage } from 'ai';
import { EventEmitter, on } from 'node:events';
import { isDeepStrictEqual } from 'node:util';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  type StreamStore,
} from '@deepagents/context';

import type { AgentDirectory } from '../../control-plane/agent-directory.ts';
import type { AgentThread } from '../../control-plane/agent-thread.ts';
import { AgentTurnId } from '../../control-plane/agent-turn-id.ts';
import type { ConversationId } from '../../mailbox/types.ts';
import type {
  TransactionalTurnQueue,
  TurnQueue,
} from '../../queue/turn-queue.ts';
import {
  hasPendingClientInput,
  hasUnansweredApprovals,
} from '../approval-controller.ts';
import type { ConversationStatusChangeSource } from './change-source.ts';
import {
  type ChildActivity,
  type ChildProgress,
  childActivityMetadataSchema,
} from './child-progress.ts';

/** Why an active conversation is not making progress on its own. */
export type ConversationActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

/**
 * Codex-shaped conversation status (`thread/status/changed`): a conversation
 * is `active` while durable work is queued or running, or while its head turn
 * waits on a host decision; `systemError` after its latest turn failed.
 */
export type ConversationStatus =
  | { type: 'idle' }
  | { type: 'active'; activeFlags: readonly ConversationActiveFlag[] }
  | { type: 'systemError' };

export interface ConversationStatusChange {
  type: 'change';
  conversation: ConversationId;
  status: ConversationStatus;
  child?: ChildProgress;
}

/** Codex's `thread/deleted`: the conversation has no chat and no turn left. */
export interface ConversationDeleted {
  type: 'deleted';
  conversation: ConversationId;
}

/** Codex's `thread/archived`: the conversation's tree was archived. */
export interface ConversationArchived {
  type: 'archived';
  conversation: ConversationId;
}

/** Codex's `thread/unarchived`: the conversation's tree is no longer archived. */
export interface ConversationUnarchived {
  type: 'unarchived';
  conversation: ConversationId;
}

export type ConversationStatusEvent =
  | ConversationStatusChange
  | ConversationDeleted
  | ConversationArchived
  | ConversationUnarchived
  | { type: 'reset' };

type ProjectorEvent =
  ConversationStatusEvent | { type: 'error'; error: unknown };

/** One projector event as it travels through the untyped `events.on` iterator. */
class ProjectorEventDelivery {
  readonly event: ProjectorEvent;

  constructor(event: ProjectorEvent) {
    this.event = event;
  }
}

export interface ConversationStatusProjectorOptions {
  store: ContextStore;
  streams: StreamManager;
  queue: TurnQueue;
  directory: AgentDirectory;
  /** Cross-process wake hints; absent means in-process changes only. */
  changeSource?: ConversationStatusChangeSource;
}

/** No subscriber holds the remote change source. */
class Detached {
  // A private member keeps the type nominal: an empty class would also
  // describe RemoteAttachment, and `instanceof` could not narrow the union.
  readonly #detached = true;
}

const DETACHED = new Detached();

/** The one remote change source subscription that every current subscriber shares. */
class RemoteAttachment {
  readonly abort = new AbortController();
  /** Resolves when the source subscribes; rejects with the error that stopped it. */
  readonly connected = new Future<void>();
  /** Opens when the consume loop has stopped. */
  readonly ended = new Latch();
}

/** Hinting other processes of a status change failed; they re-read durable state on their own transitions and on pull. */
class StatusHintWarning extends Error {
  readonly code = 'DEEPAGENTS_ZUKHRUF_STATUS_HINT_FAILED';
  readonly detail: string;

  constructor(failure: unknown, conversation: ConversationId) {
    super(
      `Hinting other processes of a status change failed: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'StatusHintWarning';
    this.detail = `chat: ${conversation.chatId}`;
  }
}

/** The events of a subscription that a disposed projector takes: none. */
async function* ended(): AsyncGenerator<ConversationStatusEvent> {
  yield* [];
}

/**
 * Derives conversation status from durable state and publishes changes.
 *
 * `read` is the authority and is correct from any process. `publish` re-reads
 * and emits only when the status differs from the last one published by this
 * process, so callers signal "something may have changed" without tracking
 * transitions themselves.
 */
export class ConversationStatusProjector {
  readonly #store: ContextStore;
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #directory: AgentDirectory;
  readonly #changeSource?: ConversationStatusChangeSource;
  readonly #emitter = new EventEmitter();
  readonly #last = new Map<
    string,
    ConversationStatusChange | ConversationDeleted
  >();
  /** The archivedAt each conversation had when this process last projected it. */
  readonly #archivedAt = new Map<string, number | undefined>();
  readonly #publishing = new Mutex(new MemoryStore());
  readonly #closing = new AbortController();
  #subscribers = 0;
  #remote: RemoteAttachment | Detached = DETACHED;

  constructor(options: ConversationStatusProjectorOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#directory = options.directory;
    this.#changeSource = options.changeSource;
  }

  read(conversation: ConversationId): Promise<ConversationStatus> {
    return conversationStatusOf(
      {
        store: this.#store,
        streams: this.#streams.store,
        queue: this.#queue,
        directory: this.#directory,
      },
      conversation,
    );
  }

  async children(conversation: ConversationId): Promise<ChildProgress[]> {
    const thread = await this.#directory.load(conversation);
    if (!thread) return [];
    const children = await Promise.all(
      (await this.#directory.listTree(thread)).map((member) =>
        this.#child(member),
      ),
    );
    return children.filter((child) => child !== undefined);
  }

  /** Records successful runtime operations outside the transport mailbox. */
  async recordActivity(
    thread: AgentThread,
    activity: ChildActivity,
  ): Promise<void> {
    if (thread.path.isRoot) return;
    return this.#serialize(thread.conversation, async (key) => {
      try {
        await this.#store.updateChat(thread.conversation.chatId, (chat) => {
          if (chat.userId !== thread.conversation.userId)
            throw new Error('Child activity owner mismatch');
          const metadata = withChildActivity(chat.metadata, activity);
          return metadata && { metadata };
        });
      } catch {
        // Observability must not turn an already accepted operation into a failed turn.
        return;
      }
      await this.#publish(thread.conversation, key);
    });
  }

  async #child(thread: AgentThread): Promise<ChildProgress | undefined> {
    if (thread.parentChatId === null) return undefined;
    const activity = await this.#queue.getTurnActivity(thread.conversation);
    const status = await this.read(thread.conversation);
    const stream = thread.lastTurnId
      ? await this.#streams.store.getStream(thread.lastTurnId)
      : undefined;
    const chat = await this.#store.getChat(thread.conversation.chatId);
    const state: ChildProgress['state'] =
      status.type === 'active' && status.activeFlags.length > 0
        ? status.activeFlags[0]
        : activity === 'running' || activity === 'queued'
          ? activity
          : stream?.status === 'cancelled'
            ? 'interrupted'
            : stream?.status === 'completed'
              ? 'completed'
              : stream?.status === 'failed'
                ? 'failed'
                : 'pending';
    return {
      chatId: thread.conversation.chatId,
      treeId: thread.treeId,
      path: thread.path.toString(),
      parentChatId: thread.parentChatId,
      declarationName: thread.declarationName,
      state,
      activities: childActivityMetadataSchema.parse(chat?.metadata?.zukhruf)
        .childActivities,
    };
  }

  /**
   * Re-reads the status after a local transition, emits it if it changed, and
   * hints other processes. Never rejects.
   */
  publish(conversation: ConversationId): Promise<void> {
    return this.#serialize(conversation, (key) =>
      this.#publish(conversation, key),
    );
  }

  async #publish(conversation: ConversationId, key: string): Promise<void> {
    if (!(await this.#project(conversation, key))) return;
    try {
      await this.#changeSource?.notify(conversation);
    } catch (error) {
      // The hint is best effort; every process re-reads durable state on
      // its own transitions and on pull.
      process.emitWarning(new StatusHintWarning(error, conversation));
    }
  }

  /**
   * The status events from now on, until `signal` aborts (which rejects with
   * its reason) or the projector is disposed (which ends them).
   */
  async subscribe(
    signal: AbortSignal,
  ): Promise<AsyncIterable<ConversationStatusEvent>> {
    const closing = this.#closing.signal;
    if (closing.aborted) return ended();
    const events = on(this.#emitter, 'event', {
      signal: AbortSignal.any([signal, closing]),
    });
    try {
      await this.#attachRemote();
    } catch (error) {
      await events.return?.();
      throw error;
    }
    const detach = () => this.#detachRemote();
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const args of events) {
            const [delivery]: unknown[] = args;
            if (!(delivery instanceof ProjectorEventDelivery)) continue;
            const { event } = delivery;
            if (event.type === 'error') throw event.error;
            yield event;
          }
        } catch (error) {
          if (!closing.aborted || signal.aborted) throw error;
        } finally {
          await detach();
        }
      },
    };
  }

  /**
   * Ends every subscription and the attachment to other processes' changes;
   * a later subscription ends at once.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    this.#closing.abort();
    const remote = this.#remote;
    if (!(remote instanceof RemoteAttachment)) return;
    remote.abort.abort();
    this.#remote = DETACHED;
    await remote.ended.wait();
  }

  /** Re-reads after a hint from another process, without hinting back. */
  #reconcile(conversation: ConversationId): Promise<void> {
    return this.#serialize(conversation, async (key) => {
      await this.#project(conversation, key);
    });
  }

  #serialize(
    conversation: ConversationId,
    step: (key: string) => Promise<void>,
  ): Promise<void> {
    const key = ConversationStatusProjector.#key(conversation);
    return this.#publishing.acquire(key, () => step(key));
  }

  async #project(conversation: ConversationId, key: string): Promise<boolean> {
    let change: ConversationStatusChange | ConversationDeleted;
    let archivedAt: number | undefined;
    let archiving = false;
    const id = { chatId: conversation.chatId, userId: conversation.userId };
    try {
      if (await this.#isGone(conversation)) {
        change = { type: 'deleted', conversation: id };
      } else {
        const status = await this.read(conversation);
        const thread = await this.#directory.load(conversation);
        archivedAt = thread?.archivedAt;
        // A mark this process has not seen yet is an archive; a mark it
        // saw that is gone is an unarchive.
        archiving = archivedAt !== this.#archivedAt.get(key);
        const child = thread ? await this.#child(thread) : undefined;
        change = {
          type: 'change',
          conversation: id,
          status,
          ...(child ? { child } : {}),
        };
      }
    } catch {
      // A read failure must not surface as a turn orphan through onSettled;
      // the next transition re-reads from durable state anyway.
      return false;
    }
    this.#archivedAt.set(key, archivedAt);
    if (archiving) {
      this.#emit({
        type: archivedAt === undefined ? 'unarchived' : 'archived',
        conversation: id,
      });
    }
    if (isDeepStrictEqual(this.#last.get(key), change)) return archiving;
    this.#last.set(key, change);
    this.#emit(change);
    return true;
  }

  /**
   * Whether the conversation has neither a chat nor a turn. A conversation
   * enqueued before its first turn opened its chat already has that turn's
   * stream; deleting a conversation removes both.
   */
  async #isGone(conversation: ConversationId): Promise<boolean> {
    if ((await this.#store.getChat(conversation.chatId)) !== undefined) {
      return false;
    }
    const turns = await this.#streams.store.listStreamIds({
      prefix: AgentTurnId.prefixOf(conversation),
    });
    return turns.length === 0;
  }

  async #attachRemote(): Promise<void> {
    this.#subscribers += 1;
    const source = this.#changeSource;
    if (!source || this.#closing.signal.aborted) return;
    let remote = this.#remote;
    if (!(remote instanceof RemoteAttachment)) {
      remote = new RemoteAttachment();
      this.#remote = remote;
      void this.#consumeRemote(source, remote);
    }
    try {
      await remote.connected.wait();
    } catch (error) {
      await this.#detachRemote();
      throw error;
    }
  }

  async #detachRemote(): Promise<void> {
    this.#subscribers -= 1;
    const remote = this.#remote;
    if (this.#subscribers > 0 || !(remote instanceof RemoteAttachment)) return;
    remote.abort.abort();
    this.#remote = DETACHED;
    await remote.ended.wait();
  }

  async #consumeRemote(
    source: ConversationStatusChangeSource,
    remote: RemoteAttachment,
  ): Promise<void> {
    let connected = false;
    try {
      const events = await source.subscribe(remote.abort.signal);
      connected = true;
      remote.connected.resolve();
      for await (const event of events) {
        if (event.type === 'reset') {
          this.#emit(event);
        } else {
          await this.#reconcile(event.conversation);
        }
      }
      if (!remote.abort.signal.aborted) {
        this.#emit({
          type: 'error',
          error: new Error('Conversation status change source ended'),
        });
      }
    } catch (error) {
      if (!connected) remote.connected.reject(error);
      if (connected && !(Error.isError(error) && error.name === 'AbortError')) {
        this.#emit({ type: 'error', error });
      }
    } finally {
      if (this.#remote === remote) this.#remote = DETACHED;
      remote.ended.open();
    }
  }

  #emit(event: ProjectorEvent): void {
    this.#emitter.emit('event', new ProjectorEventDelivery(event));
  }

  static #key({ chatId, userId }: ConversationId): string {
    return JSON.stringify([chatId, userId]);
  }
}

/**
 * `metadata` with `activity` as the receipt of its kind, or `undefined` when
 * the chat already holds it or a later one.
 */
export function withChildActivity(
  metadata: Record<string, unknown> | undefined,
  activity: ChildActivity,
): Record<string, unknown> | undefined {
  const zukhruf = childActivityMetadataSchema.parse(metadata?.zukhruf);
  const activities = zukhruf.childActivities;
  const previous = activities[activity.type];
  if (previous?.id === activity.id || (previous && previous.at > activity.at)) {
    return undefined;
  }
  return {
    ...metadata,
    zukhruf: {
      ...zukhruf,
      childActivities: { ...activities, [activity.type]: activity },
    },
  };
}

/** The storage parts a conversation's status is read through. */
interface ConversationStatusParts {
  store: ContextStore;
  streams: StreamStore;
  queue: TransactionalTurnQueue;
  directory: AgentDirectory;
}

export async function conversationStatusOf(
  parts: ConversationStatusParts,
  conversation: ConversationId,
): Promise<ConversationStatus> {
  const activity = await parts.queue.getTurnActivity(conversation);
  if (activity === 'running') return { type: 'active', activeFlags: [] };

  // Opening an engine creates its chat, and a deleted chat's last turn
  // still publishes its status when it settles.
  const chatExists =
    (await parts.store.getChat(conversation.chatId)) !== undefined;
  const messages = chatExists
    ? await new ContextEngine({
        store: parts.store,
        chatId: conversation.chatId,
        userId: conversation.userId,
      }).getMessages()
    : [];
  const head = messages.at(-1);
  const thread = await parts.directory.load(conversation);
  const streamId =
    thread?.lastTurnId ?? (head?.role === 'assistant' ? head.id : undefined);
  const stream = streamId ? await parts.streams.getStream(streamId) : undefined;
  // A queued or running continuation carries the host's answer; once it
  // ends, however it ended, the head's open tool calls wait again.
  const continuing =
    stream?.status === 'queued' || stream?.status === 'running';
  const activeFlags =
    !continuing && head?.role === 'assistant' ? activeFlagsOf(head) : [];
  if (activity === 'queued' || activeFlags.length > 0) {
    return { type: 'active', activeFlags };
  }
  if (stream?.status === 'failed') return { type: 'systemError' };
  return { type: 'idle' };
}

function activeFlagsOf(message: UIMessage): ConversationActiveFlag[] {
  const flags: ConversationActiveFlag[] = [];
  if (hasUnansweredApprovals(message)) flags.push('waitingOnApproval');
  if (hasPendingClientInput(message)) flags.push('waitingOnUserInput');
  return flags;
}
