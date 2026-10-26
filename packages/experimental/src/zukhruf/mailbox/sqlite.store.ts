import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { SETUP, statements } from './ddl.sqlite.ts';
import {
  type MailboxEndTurnResult,
  type MailboxEnqueueResult,
  MailboxStore,
} from './store.ts';
import {
  type ConversationId,
  type InterAgentCommunication,
  InterAgentCommunicationTypes,
} from './types.ts';

const tables = new Declaration(statements, { rows: 'keep' });

const BUSY_TIMEOUT_MS = 5_000;

const conversationIdSchema = z.object({
  chatId: z.string(),
  userId: z.string(),
});

/** One `InterAgentCommunication` as `enqueue` serializes it. */
const communicationSchema = z.object({
  id: z.string(),
  type: z.enum(InterAgentCommunicationTypes),
  author: conversationIdSchema,
  recipient: conversationIdSchema,
  otherRecipients: z.array(conversationIdSchema),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  triggerTurn: z.boolean(),
}) satisfies z.ZodType<InterAgentCommunication>;

const mailboxItemRowsSchema = z.array(
  z.object({
    sequence: z.number(),
    communication: z
      .string()
      .transform((text): unknown => JSON.parse(text))
      .pipe(communicationSchema),
  }),
);

/** SQLite-backed mailbox for durable cross-process delivery. */
export class SqliteMailboxStore extends MailboxStore implements Disposable {
  #database: DatabaseSync;

  constructor(path: string) {
    super();
    this.#database = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    this.#database.exec(SETUP);
    tables.apply(this.#database);
  }

  override async beginTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<void> {
    transaction(
      this.#database,
      () => {
        this.#database
          .prepare(
            `INSERT INTO zukhruf_mailbox_activity (
             recipient_chat_id,
             recipient_user_id,
             turn_id
           ) VALUES (?, ?, ?)
           ON CONFLICT (recipient_chat_id, recipient_user_id)
           DO UPDATE SET turn_id = excluded.turn_id`,
          )
          .run(recipient.chatId, recipient.userId, turnId);
      },
      { mode: 'immediate' },
    );
  }

  override async enqueue(
    communication: InterAgentCommunication,
  ): Promise<MailboxEnqueueResult> {
    return transaction(
      this.#database,
      () => {
        const consumedTerminal =
          communication.type === InterAgentCommunicationTypes.FinalAnswer &&
          this.#hasConsumedTerminal(communication.id);
        if (!consumedTerminal) {
          this.#database
            .prepare(
              `INSERT OR IGNORE INTO zukhruf_mailbox_items (
               recipient_chat_id,
               recipient_user_id,
               communication
             ) VALUES (?, ?, ?)`,
            )
            .run(
              communication.recipient.chatId,
              communication.recipient.userId,
              JSON.stringify(communication),
            );
        }
        return {
          recipientActive: this.#isTurnActive(communication.recipient),
        };
      },
      { mode: 'immediate' },
    );
  }

  override async endTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<MailboxEndTurnResult> {
    return transaction(
      this.#database,
      () => {
        const result = this.#database
          .prepare(
            `DELETE FROM zukhruf_mailbox_activity
            WHERE recipient_chat_id = ?
              AND recipient_user_id = ?
              AND turn_id = ?`,
          )
          .run(recipient.chatId, recipient.userId, turnId);
        return {
          hasPending: this.#hasPending(recipient),
          turnEnded: result.changes > 0,
        };
      },
      { mode: 'immediate' },
    );
  }

  override async hasPending(recipient: ConversationId): Promise<boolean> {
    return this.#hasPending(recipient);
  }

  #hasPending(recipient: ConversationId): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1
           FROM zukhruf_mailbox_items
          WHERE recipient_chat_id = ?
            AND recipient_user_id = ?
          LIMIT 1`,
      )
      .get(recipient.chatId, recipient.userId);
    return row !== undefined;
  }

  #isTurnActive(recipient: ConversationId): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1
           FROM zukhruf_mailbox_activity
          WHERE recipient_chat_id = ?
            AND recipient_user_id = ?
          LIMIT 1`,
      )
      .get(recipient.chatId, recipient.userId);
    return row !== undefined;
  }

  #hasConsumedTerminal(communicationId: string): boolean {
    const row = this.#database
      .prepare(
        `SELECT 1
           FROM zukhruf_mailbox_consumed_terminal_ids
          WHERE communication_id = ?
          LIMIT 1`,
      )
      .get(communicationId);
    return row !== undefined;
  }

  override async drain(
    recipient: ConversationId,
  ): Promise<InterAgentCommunication[]> {
    return this.#drain(recipient, false);
  }

  override async drainLeadingQueueOnly(
    recipient: ConversationId,
  ): Promise<InterAgentCommunication[]> {
    return this.#drain(recipient, true);
  }

  #drain(
    recipient: ConversationId,
    leadingQueueOnly: boolean,
  ): InterAgentCommunication[] {
    return transaction(
      this.#database,
      () => {
        const items = mailboxItemRowsSchema.parse(
          this.#database
            .prepare(
              `SELECT sequence, communication
               FROM zukhruf_mailbox_items
              WHERE recipient_chat_id = ?
                AND recipient_user_id = ?
              ORDER BY sequence`,
            )
            .all(recipient.chatId, recipient.userId),
        );
        const firstTrigger = leadingQueueOnly
          ? items.findIndex(({ communication }) => communication.triggerTurn)
          : -1;
        const consumed =
          firstTrigger === -1 ? items : items.slice(0, firstTrigger);
        const lastConsumed = consumed.at(-1);
        if (lastConsumed) {
          // Only terminal IDs get durable tombstones. Ordinary random-ID mail
          // does not need permanent dedup state after FIFO consumption.
          const tombstone = this.#database.prepare(
            `INSERT OR IGNORE
             INTO zukhruf_mailbox_consumed_terminal_ids (communication_id)
           VALUES (?)`,
          );
          for (const { communication } of consumed) {
            if (
              communication.type === InterAgentCommunicationTypes.FinalAnswer
            ) {
              tombstone.run(communication.id);
            }
          }
          this.#database
            .prepare(
              `DELETE FROM zukhruf_mailbox_items
            WHERE recipient_chat_id = ?
              AND recipient_user_id = ?
              AND sequence <= ?`,
            )
            .run(recipient.chatId, recipient.userId, lastConsumed.sequence);
        }
        return consumed.map(({ communication }) => communication);
      },
      { mode: 'immediate' },
    );
  }

  close(): void {
    if (!this.#database.isOpen) return;
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
