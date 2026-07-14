import { DatabaseSync } from 'node:sqlite';

import {
  type MailboxEndTurnResult,
  type MailboxEnqueueResult,
  MailboxStore,
} from './store.ts';
import {
  type ConversationId,
  type InterAgentCommunication,
  InterAgentCommunicationType,
} from './types.ts';

const DDL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS zukhruf_mailbox_items (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_chat_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    communication TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS zukhruf_mailbox_activity (
    recipient_chat_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    PRIMARY KEY (recipient_chat_id, recipient_user_id)
  );

  CREATE TABLE IF NOT EXISTS zukhruf_mailbox_consumed_terminal_ids (
    communication_id TEXT PRIMARY KEY
  );

  CREATE INDEX IF NOT EXISTS zukhruf_mailbox_recipient_sequence
    ON zukhruf_mailbox_items (
      recipient_chat_id,
      recipient_user_id,
      sequence
    );

  CREATE UNIQUE INDEX IF NOT EXISTS zukhruf_mailbox_communication_id
    ON zukhruf_mailbox_items (
      json_extract(communication, '$.id')
    );
`;

const BUSY_TIMEOUT_MS = 5_000;

/** SQLite-backed mailbox for durable cross-process delivery. */
export class SqliteMailboxStore extends MailboxStore implements Disposable {
  #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    super();
    this.#database = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    this.#database.exec(DDL);
  }

  override async beginTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<void> {
    this.#transaction(() => {
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
    });
  }

  override async enqueue(
    communication: InterAgentCommunication,
  ): Promise<MailboxEnqueueResult> {
    return this.#transaction(() => {
      const consumedTerminal =
        communication.type === InterAgentCommunicationType.FinalAnswer &&
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
    });
  }

  override async endTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<MailboxEndTurnResult> {
    return this.#transaction(() => {
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
    });
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
    return this.#transaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT sequence, communication
             FROM zukhruf_mailbox_items
            WHERE recipient_chat_id = ?
              AND recipient_user_id = ?
            ORDER BY sequence`,
        )
        .all(recipient.chatId, recipient.userId) as Array<{
        sequence: number;
        communication: string;
      }>;
      const items = rows.map((row) => ({
        sequence: row.sequence,
        communication: JSON.parse(row.communication) as InterAgentCommunication,
      }));
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
          if (communication.type === InterAgentCommunicationType.FinalAnswer) {
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
    });
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error when SQLite already ended the transaction.
      }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
