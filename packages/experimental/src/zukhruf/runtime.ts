import { type UIMessage, isToolUIPart } from 'ai';

import {
  ContextEngine,
  type ContextStore,
  PollingChangeSource,
  StreamManager,
  type StreamStore,
  agent,
  assistant,
  chat,
  user,
} from '@deepagents/context';

import type { AgentDeclaration } from './agent.ts';
import type { ConsumeContext, TurnQueue, TurnRef } from './queue/turn-queue.ts';

export interface RuntimeOptions {
  store: ContextStore;
  streamStore: StreamStore;
  queue: TurnQueue;
}

export interface ConversationId {
  chatId: string;
  userId: string;
}

export interface WorkOptions {
  concurrency?: number;
}

export interface TurnInput {
  /**
   * The ask's identity, supplied by the caller: any unique string (a client's
   * message id, or `crypto.randomUUID()` when the caller has no natural key).
   * It doubles as the stream id and the assistant message id. Enqueueing the
   * same id again reattaches to the existing turn instead of running it
   * twice; the first call's `input` wins.
   */
  id: string;
  input: string;
}

const SETTLED_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
]);

function pendingToolPart(message: UIMessage) {
  return message.parts.find(
    (part) => isToolUIPart(part) && !SETTLED_TOOL_STATES.has(part.state),
  );
}

/**
 * Executes an AgentDeclaration as a background agent, split into three roles:
 *
 * - `enqueue` — durably queue a turn (the queue carries the user message
 *   until execution); executes nothing. Safe from any short-lived process.
 * - `work` — start a worker that consumes queued turns; each turn runs
 *   start-to-finish in this process, serialized per chat by the TurnQueue.
 * - `observe` — reconnect/cancel from anywhere; never spins a sandbox.
 *
 * Plus the approval verbs: a turn pauses when the model calls a
 * `needsApproval` tool (the pause is pure data — a dangling tool part on the
 * chain head + a terminal stream); `approve`/`deny` resolve it and re-run the
 * turn as a continuation. Turns enqueued while a chat awaits approval QUEUE
 * BEHIND it (parked, revived in order after the continuation).
 */
export function createRuntime(
  declaration: AgentDeclaration,
  options: RuntimeOptions,
) {
  const { store, streamStore, queue } = options;
  const manager = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });

  function engineFor({ chatId, userId }: ConversationId) {
    return new ContextEngine({ store, chatId, userId });
  }

  async function executeTurn(
    turn: TurnRef,
    { signal, park }: ConsumeContext,
  ): Promise<void> {
    const status = await streamStore.getStreamStatus(turn.streamId);
    if (status !== 'queued' && status !== 'running') return;

    const engine = engineFor(turn).set(...declaration.instructions);

    if (turn.kind === 'ask') {
      const head = (await engine.getMessages()).at(-1);
      if (head?.role === 'assistant' && pendingToolPart(head)) {
        await park();
        return;
      }
      engine.set(
        user(turn.input),
        assistant({ id: turn.streamId, role: 'assistant', parts: [] }),
      );
      await engine.save({ branch: true });
    }

    const sandbox = await declaration.sandbox({
      chatId: turn.chatId,
      userId: turn.userId,
    });
    const ai = agent({
      name: declaration.name,
      model: declaration.model,
      sandbox,
      context: engine,
      tools: declaration.tools,
    });

    const abort = new AbortController();
    const onWorkerAbort = () => abort.abort();
    signal.addEventListener('abort', onWorkerAbort, { once: true });
    try {
      const stream = await chat(ai, { abortSignal: abort.signal });
      await manager.persist(stream, turn.streamId, {
        onCancelDetected: () => abort.abort(),
      });
    } finally {
      signal.removeEventListener('abort', onWorkerAbort);
    }
  }

  async function respondToApproval(
    conversation: ConversationId,
    toolCallId: string,
    approval: { approved: true } | { approved: false; reason?: string },
  ) {
    const engine = engineFor(conversation);
    const head = (await engine.getMessages()).at(-1);
    if (head?.role !== 'assistant') {
      throw new Error(
        'approve: no paused turn — the chain head is not an assistant message',
      );
    }
    const part = head.parts.find(
      (p) => isToolUIPart(p) && p.toolCallId === toolCallId,
    );
    if (!part || !isToolUIPart(part)) {
      throw new Error(
        `approve: no tool call "${toolCallId}" on the paused turn`,
      );
    }
    if (part.state !== 'approval-requested') {
      // Already responded (or settled) — idempotent reattach.
      return { id: head.id, stream: manager.watch(head.id) };
    }

    const responded = {
      ...part,
      state: 'approval-responded',
      approval: { ...part.approval, ...approval },
    };
    const updated: UIMessage = {
      ...head,
      parts: head.parts.map((p) => (p === part ? responded : p)),
    } as UIMessage;
    await engine.continue(assistant(updated));

    try {
      await manager.reopen(head.id);
    } catch {
      // Lost the benign race: a concurrent approve already reopened (stream
      // no longer terminal) and pushed the continuation. Reattach.
      return { id: head.id, stream: manager.watch(head.id) };
    }
    await queue.push({
      kind: 'continuation',
      streamId: head.id,
      chatId: conversation.chatId,
      userId: conversation.userId,
    });
    // Revive turns that parked behind the approval; the continuation's
    // priority guarantees it runs before them.
    await queue.resumeParked(conversation.chatId);
    return { id: head.id, stream: manager.watch(head.id) };
  }

  return {
    async enqueue({ chatId, userId }: ConversationId, turn: TurnInput) {
      if (!turn.id) {
        throw new Error(
          'enqueue: turn id is required — it names the ask, making retries idempotent',
        );
      }
      // register is an upsert (ON CONFLICT DO NOTHING) and the queue is
      // at-least-once, so a retried enqueue may create a duplicate job — the
      // queue serializes it behind the original and executeTurn's terminal
      // check turns it into a no-op. The stream row, not the queue, is the
      // durable dedup: it never expires with job retention.
      await manager.register(turn.id);
      await queue.push({
        kind: 'ask',
        streamId: turn.id,
        chatId,
        userId,
        input: turn.input,
      });
      return { id: turn.id, stream: manager.watch(turn.id) };
    },

    async approve(conversation: ConversationId, input: { toolCallId: string }) {
      return respondToApproval(conversation, input.toolCallId, {
        approved: true,
      });
    },

    async deny(
      conversation: ConversationId,
      input: { toolCallId: string; reason?: string },
    ) {
      return respondToApproval(conversation, input.toolCallId, {
        approved: false,
        reason: input.reason,
      });
    },

    observe({ chatId, userId }: ConversationId) {
      const engine = engineFor({ chatId, userId });

      async function headStreamId(): Promise<string | undefined> {
        const head = await engine.headMessage();
        return head?.name === 'assistant' ? head.id : undefined;
      }

      return {
        engine,
        async resume() {
          const id = await headStreamId();
          if (!id) return null;
          const status = await streamStore.getStreamStatus(id);
          return status ? manager.watch(id) : null;
        },
        async cancel(streamId?: string) {
          const id = streamId ?? (await headStreamId());
          if (!id) return;
          const status = await streamStore.getStreamStatus(id);
          if (status === 'queued' || status === 'running') {
            await manager.cancel(id);
          }
        },
      };
    },

    async work(options?: WorkOptions): Promise<AsyncDisposable> {
      return queue.consume(executeTurn, {
        concurrency: options?.concurrency,
        onOrphaned: async (turn, error) => {
          const status = await streamStore.getStreamStatus(turn.streamId);
          if (status === 'queued' || status === 'running') {
            await streamStore.updateStreamStatus(turn.streamId, 'failed', {
              error,
            });
          }
        },
      });
    },
  };
}
