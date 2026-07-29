import { PGlite } from '@electric-sql/pglite';
import { InMemoryFs } from 'just-bash';
import { randomUUID } from 'node:crypto';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  type AgentModel,
  InMemoryContextStore,
  SqliteStreamStore,
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
  readonly #boss: PgBoss;
  readonly #database: PGlite;
  readonly #streamStore: SqliteStreamStore;
  readonly #mailboxStore: SqliteMailboxStore;
  readonly #participants: RunningParticipant[];
  readonly #workers: AsyncDisposable[];
  readonly #replies: ReplyInbox;
  readonly #onMessage?: WhatsAppGroupOptions['onMessage'];
  readonly #messages: WhatsAppMessage[] = [];
  #closed = false;

  private constructor(
    options: WhatsAppGroupOptions,
    resources: {
      boss: PgBoss;
      database: PGlite;
      streamStore: SqliteStreamStore;
      mailboxStore: SqliteMailboxStore;
      participants: RunningParticipant[];
      workers: AsyncDisposable[];
      replies: ReplyInbox;
    },
  ) {
    this.#boss = resources.boss;
    this.#database = resources.database;
    this.#streamStore = resources.streamStore;
    this.#mailboxStore = resources.mailboxStore;
    this.#participants = resources.participants;
    this.#workers = resources.workers;
    this.#replies = resources.replies;
    this.#onMessage = options.onMessage;
  }

  static async create(options: WhatsAppGroupOptions): Promise<WhatsAppGroup> {
    WhatsAppGroup.#validate(options);

    const database = new PGlite();
    const boss = new PgBoss({ db: fromPglite(database), backend: 'pglite' });
    boss.on('error', (error) => console.error('[queue error]', error));
    const streamStore = new SqliteStreamStore(':memory:');
    const mailboxStore = new SqliteMailboxStore(':memory:');
    const store = new InMemoryContextStore();
    const replies = new ReplyInbox();
    const participants: RunningParticipant[] = [];
    const workers: AsyncDisposable[] = [];

    try {
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
            streamStore,
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
        workers.push(await runtime.work());
      }

      return new WhatsAppGroup(options, {
        boss,
        database,
        streamStore,
        mailboxStore,
        participants,
        workers,
        replies,
      });
    } catch (error) {
      await WhatsAppGroup.#disposeResources({
        boss,
        database,
        streamStore,
        mailboxStore,
        workers,
      });
      throw error;
    }
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
    await WhatsAppGroup.#disposeResources({
      boss: this.#boss,
      database: this.#database,
      streamStore: this.#streamStore,
      mailboxStore: this.#mailboxStore,
      workers: this.#workers,
    });
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

  static async #disposeResources(resources: {
    boss: PgBoss;
    database: PGlite;
    streamStore: SqliteStreamStore;
    mailboxStore: SqliteMailboxStore;
    workers: AsyncDisposable[];
  }): Promise<void> {
    for (const worker of resources.workers.toReversed()) {
      await worker[Symbol.asyncDispose]();
    }
    await resources.boss.stop({ graceful: false });
    await resources.database.close();
    resources.streamStore.close();
    resources.mailboxStore.close();
  }
}
