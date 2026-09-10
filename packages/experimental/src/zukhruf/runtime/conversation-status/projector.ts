import type { UIMessage } from 'ai';
import { EventEmitter, on } from 'node:events';
import { isDeepStrictEqual } from 'node:util';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
} from '@deepagents/context';

import type { AgentDirectory } from '../../control-plane/agent-directory.ts';
import type { AgentThread } from '../../control-plane/agent-thread.ts';
import type { ConversationId } from '../../mailbox/types.ts';
import type { TurnQueue } from '../../queue/turn-queue.ts';
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

export type ConversationStatusEvent =
  ConversationStatusChange | { type: 'reset' };

type ProjectorEvent =
  ConversationStatusEvent | { type: 'error'; error: unknown };

export interface ConversationStatusProjectorOptions {
  store: ContextStore;
  streams: StreamManager;
  queue: TurnQueue;
  directory: AgentDirectory;
  /** Cross-process wake hints; absent means in-process changes only. */
  changeSource?: ConversationStatusChangeSource;
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
  readonly #last = new Map<string, ConversationStatusChange>();
  readonly #publishing = new Map<string, Promise<void>>();
  #subscribers = 0;
  #remote?: { abort: AbortController; ready: Promise<void> };

  constructor(options: ConversationStatusProjectorOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#directory = options.directory;
    this.#changeSource = options.changeSource;
  }

  async read(conversation: ConversationId): Promise<ConversationStatus> {
    const activity = await this.#queue.getTurnActivity(conversation);
    if (activity === 'running') return { type: 'active', activeFlags: [] };

    const engine = new ContextEngine({
      store: this.#store,
      chatId: conversation.chatId,
      userId: conversation.userId,
    });
    const head = (await engine.getMessages()).at(-1);
    const thread = await this.#directory.load(conversation);
    const streamId =
      thread?.lastTurnId ?? (head?.role === 'assistant' ? head.id : undefined);
    const stream = streamId
      ? await this.#streams.store.getStream(streamId)
      : undefined;
    const activeFlags =
      stream?.status === 'completed' && head?.role === 'assistant'
        ? activeFlagsOf(head)
        : [];
    if (activity === 'queued' || activeFlags.length > 0) {
      return { type: 'active', activeFlags };
    }
    if (stream?.status === 'failed') return { type: 'systemError' };
    return { type: 'idle' };
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
          const metadata = childActivityMetadataSchema.parse(
            chat.metadata?.zukhruf,
          );
          const activities = metadata.childActivities;
          const previous = activities[activity.type];
          if (
            previous?.id === activity.id ||
            (previous && previous.at > activity.at)
          )
            return undefined;
          return {
            metadata: {
              ...chat.metadata,
              zukhruf: {
                ...metadata,
                childActivities: { ...activities, [activity.type]: activity },
              },
            },
          };
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
    } catch {
      // The hint is best effort; every process re-reads durable state on
      // its own transitions and on pull.
    }
  }

  async subscribe(
    signal: AbortSignal,
  ): Promise<AsyncIterable<ConversationStatusEvent>> {
    const events = on(this.#emitter, 'event', { signal });
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
          for await (const [event] of events) {
            const projected = event as ProjectorEvent;
            if (projected.type === 'error') throw projected.error;
            yield projected;
          }
        } finally {
          detach();
        }
      },
    };
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
    const previous = this.#publishing.get(key) ?? Promise.resolve();
    const next = previous.then(() => step(key));
    this.#publishing.set(key, next);
    void next.finally(() => {
      if (this.#publishing.get(key) === next) this.#publishing.delete(key);
    });
    return next;
  }

  async #project(conversation: ConversationId, key: string): Promise<boolean> {
    let change: ConversationStatusChange;
    try {
      const status = await this.read(conversation);
      const thread = await this.#directory.load(conversation);
      const child = thread ? await this.#child(thread) : undefined;
      change = {
        type: 'change',
        conversation: {
          chatId: conversation.chatId,
          userId: conversation.userId,
        },
        status,
        ...(child ? { child } : {}),
      };
    } catch {
      // A read failure must not surface as a turn orphan through onSettled;
      // the next transition re-reads from durable state anyway.
      return false;
    }
    if (isDeepStrictEqual(this.#last.get(key), change)) return false;
    this.#last.set(key, change);
    this.#emitter.emit('event', change);
    return true;
  }

  async #attachRemote(): Promise<void> {
    this.#subscribers += 1;
    const source = this.#changeSource;
    if (!source) return;
    if (!this.#remote) {
      const abort = new AbortController();
      const ready = Promise.withResolvers<void>();
      const remote = { abort, ready: ready.promise };
      this.#remote = remote;
      void this.#consumeRemote(source, remote, ready);
    }
    try {
      await this.#remote.ready;
    } catch (error) {
      this.#detachRemote();
      throw error;
    }
  }

  #detachRemote(): void {
    this.#subscribers -= 1;
    if (this.#subscribers > 0 || !this.#remote) return;
    this.#remote.abort.abort();
    this.#remote = undefined;
  }

  async #consumeRemote(
    source: ConversationStatusChangeSource,
    remote: { abort: AbortController; ready: Promise<void> },
    ready: PromiseWithResolvers<void>,
  ): Promise<void> {
    let connected = false;
    try {
      const events = await source.subscribe(remote.abort.signal);
      connected = true;
      ready.resolve();
      for await (const event of events) {
        if (event.type === 'reset') {
          this.#emitter.emit('event', event);
        } else {
          await this.#reconcile(event.conversation);
        }
      }
      if (!remote.abort.signal.aborted) {
        this.#emitter.emit('event', {
          type: 'error',
          error: new Error('Conversation status change source ended'),
        } satisfies ProjectorEvent);
      }
    } catch (error) {
      if (!connected) ready.reject(error);
      if (
        connected &&
        !(error instanceof Error && error.name === 'AbortError')
      ) {
        this.#emitter.emit('event', {
          type: 'error',
          error,
        } satisfies ProjectorEvent);
      }
    } finally {
      if (this.#remote === remote) this.#remote = undefined;
    }
  }

  static #key({ chatId, userId }: ConversationId): string {
    return JSON.stringify([chatId, userId]);
  }
}

function activeFlagsOf(message: UIMessage): ConversationActiveFlag[] {
  const flags: ConversationActiveFlag[] = [];
  if (hasUnansweredApprovals(message)) flags.push('waitingOnApproval');
  if (hasPendingClientInput(message)) flags.push('waitingOnUserInput');
  return flags;
}
