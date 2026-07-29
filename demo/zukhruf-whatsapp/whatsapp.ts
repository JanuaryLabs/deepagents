import { PGlite } from '@electric-sql/pglite';
import { InMemoryFs } from 'just-bash';
import { randomUUID } from 'node:crypto';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  type AgentModel,
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
  role,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineTool,
} from '@deepagents/experimental/zukhruf';

export interface WhatsAppParticipant {
  name: string;
  specialty: string;
  model: AgentModel;
}

export interface WhatsAppMessage {
  id: string;
  author: string;
  content: string;
}

export interface WhatsAppGroupOptions {
  userId: string;
  participants: WhatsAppParticipant[];
  onMessage?: (message: WhatsAppMessage) => void | Promise<void>;
}

interface RunningParticipant {
  name: string;
  conversation: { chatId: string; userId: string };
  runtime: AgentRuntime;
}

class ReplyInbox {
  #replies: WhatsAppMessage[] = [];

  post(author: string, content: string): void {
    this.#replies.push({ id: randomUUID(), author, content });
  }

  drain(): WhatsAppMessage[] {
    return this.#replies.splice(0);
  }
}

/**
 * A WhatsApp-style group host: each new public message wakes every other
 * participant concurrently. A participant is publicly silent unless it calls
 * `reply_to_group`; ordinary assistant text remains private to that agent.
 */
export class WhatsAppGroup implements AsyncDisposable {
  readonly #resources: AsyncDisposableStack;
  readonly #participants: RunningParticipant[];
  readonly #replies: ReplyInbox;
  readonly #onMessage?: WhatsAppGroupOptions['onMessage'];
  readonly #messages: WhatsAppMessage[] = [];
  #closed = false;

  private constructor(
    options: WhatsAppGroupOptions,
    resources: {
      resources: AsyncDisposableStack;
      participants: RunningParticipant[];
      replies: ReplyInbox;
    },
  ) {
    this.#resources = resources.resources;
    this.#participants = resources.participants;
    this.#replies = resources.replies;
    this.#onMessage = options.onMessage;
  }

  static async create(options: WhatsAppGroupOptions): Promise<WhatsAppGroup> {
    WhatsAppGroup.#validate(options);

    await using resources = new AsyncDisposableStack();
    const database = resources.adopt(new PGlite(), (database) =>
      database.close(),
    );
    const boss = resources.adopt(
      new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
      (boss) => boss.stop({ graceful: false }),
    );
    boss.on('error', (error) => console.error('[queue error]', error));
    const streamStore = resources.adopt(
      new SqliteStreamStore(':memory:'),
      (store) => store.close(),
    );
    const streams = new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    });
    const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
    const store = new InMemoryContextStore();
    const replies = new ReplyInbox();
    const participants: RunningParticipant[] = [];

    await boss.start();
    for (const [index, participant] of options.participants.entries()) {
      const queue = new PgBossTurnQueue(boss, {
        queue: `zukhruf-whatsapp-${index}`,
        pollingIntervalSeconds: 0.5,
        schema: 'pgboss',
      });
      await queue.initialize();

      const runtime = new AgentRuntime(
        defineAgent({
          name: participant.name,
          model: participant.model,
          sandbox: defineSandbox(() =>
            createVirtualSandbox({ fs: new InMemoryFs() }),
          ),
          instructions: [
            role(
              [
                `You are ${participant.name} in a WhatsApp-style group chat. ${participant.specialty}`,
                'Every turn is a notification containing new public group messages.',
                'Read them and decide autonomously whether your specialty gives you something useful and non-duplicative to add.',
                'If yes, call reply_to_group with the concise message you want everyone to see.',
                'If no, do not call reply_to_group. Do not reply merely to agree, repeat, acknowledge, or announce silence.',
                'Your ordinary assistant text is private and never appears in the group.',
              ].join(' '),
            ),
          ],
          tools: {
            reply_to_group: defineTool({
              description:
                'Post one useful contribution to the public group chat.',
              inputSchema: z.object({
                message: z.string().trim().min(1),
              }),
              execute: async ({ message }) => {
                replies.post(participant.name, message);
                return { posted: true };
              },
            }),
          },
        }),
        {
          store,
          streams,
          queue,
          mailboxStore,
        },
      );

      participants.push({
        name: participant.name,
        conversation: {
          chatId: `whatsapp-${index}`,
          userId: options.userId,
        },
        runtime,
      });
      resources.use(await runtime.work());
    }

    return new WhatsAppGroup(options, {
      resources: resources.move(),
      participants,
      replies,
    });
  }

  async send(content: string): Promise<readonly WhatsAppMessage[]> {
    if (this.#closed) throw new Error('WhatsAppGroup is closed');
    const message = content.trim();
    if (!message) throw new Error('WhatsAppGroup message cannot be empty');

    this.#replies.drain();
    let pending: WhatsAppMessage[] = [
      { id: randomUUID(), author: 'user', content: message },
    ];
    await this.#publish(pending);

    while (pending.length > 0) {
      await Promise.all(
        this.#participants.map(async (participant) => {
          const notifications = pending.filter(
            ({ author }) => author !== participant.name,
          );
          if (notifications.length === 0) return;

          const turn = await participant.runtime.enqueue(
            participant.conversation,
            {
              id: randomUUID(),
              input: WhatsAppGroup.#notification(notifications),
            },
          );
          await turn.stream.pipeTo(new WritableStream());
        }),
      );

      pending = this.#replies.drain();
      await this.#publish(pending);
    }

    return this.#messages;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#resources.disposeAsync();
  }

  async #publish(messages: WhatsAppMessage[]): Promise<void> {
    for (const message of messages) {
      this.#messages.push(message);
      await this.#onMessage?.(message);
    }
  }

  static #notification(messages: WhatsAppMessage[]): string {
    return [
      'New WhatsApp group messages:',
      '',
      ...messages.flatMap(({ author, content }) => [`${author}:`, content, '']),
      'Reply only through reply_to_group when you have something useful to add.',
    ].join('\n');
  }

  static #validate(options: WhatsAppGroupOptions): void {
    if (!options.userId.trim()) {
      throw new Error('WhatsAppGroup userId cannot be empty');
    }
    if (options.participants.length === 0) {
      throw new Error('WhatsAppGroup requires at least one participant');
    }
    const names = new Set<string>();
    for (const participant of options.participants) {
      if (
        !participant.name.trim() ||
        participant.name !== participant.name.trim()
      ) {
        throw new Error(
          'WhatsAppGroup participant names must be non-empty and unpadded',
        );
      }
      if (names.has(participant.name)) {
        throw new Error(
          `WhatsAppGroup participant name "${participant.name}" is duplicated`,
        );
      }
      names.add(participant.name);
    }
  }
}
