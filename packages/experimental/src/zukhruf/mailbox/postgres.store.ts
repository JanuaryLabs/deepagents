import type { Pool } from 'pg';
import { z } from 'zod';

import {
  PostgresStoreDatabase,
  type PostgresTransaction,
  lockSchemaDDL,
} from '@deepagents/context';

import { communicationSchema } from './communication-schema.ts';
import { mailboxDDL } from './ddl.postgres.ts';
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

const mailboxItemRowsSchema = z.array(
  z.object({
    sequence: z.string(),
    communication: communicationSchema,
  }),
);

const existsRowsSchema = z.tuple([z.object({ exists: z.boolean() })]);

export interface PostgresMailboxStoreOptions {
  /** Borrowed: the host owns the pool and the store never ends it. */
  pool: Pool;
  /** PostgreSQL schema the mailbox tables live in. Default: `public`. */
  schema?: string;
}

/** PostgreSQL-backed mailbox that every worker on the database shares. */
/** The part of the mailbox that writes inside a caller's transaction. */
export type TransactionalMailboxStore = Pick<
  MailboxStore,
  'enqueue' | 'beginTurn' | 'hasPendingTriggerTurn'
>;

export class PostgresMailboxStore extends MailboxStore {
  readonly #database: PostgresStoreDatabase;

  private constructor(database: PostgresStoreDatabase) {
    super();
    this.#database = database;
  }

  /** Opens the store: creates its schema objects before it returns. */
  static async create(
    options: PostgresMailboxStoreOptions,
  ): Promise<PostgresMailboxStore> {
    const database = new PostgresStoreDatabase(options.pool, options.schema);
    await database.query(
      lockSchemaDDL(mailboxDDL(database.schema), database.schema),
    );
    return new PostgresMailboxStore(database);
  }

  /**
   * A view of this store whose reads and writes run inside `tx`. Each of its
   * writes takes the recipient's lock in a savepoint of `tx`, and the lock is
   * held until `tx` ends.
   */
  bind(tx: PostgresTransaction): TransactionalMailboxStore {
    return new PostgresMailboxStore(this.#database.bind(tx));
  }

  /**
   * Runs `fn` while holding the recipient's lock, so enqueue, drain and turn
   * handoff on one mailbox take turns across every worker, as SQLite's
   * immediate transactions do.
   */
  #forRecipient<T>(
    recipient: ConversationId,
    fn: (tx: PostgresTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `zukhruf:mailbox:${JSON.stringify([this.#database.schema, recipient.chatId, recipient.userId])}`,
      ]);
      return fn(tx);
    });
  }

  override async beginTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<void> {
    await this.#forRecipient(recipient, (client) =>
      client.query(
        `INSERT INTO ${this.#database.table('zukhruf_mailbox_activity')}
           (recipient_chat_id, recipient_user_id, turn_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (recipient_chat_id, recipient_user_id)
         DO UPDATE SET turn_id = EXCLUDED.turn_id`,
        [recipient.chatId, recipient.userId, turnId],
      ),
    );
  }

  override enqueue(
    communication: InterAgentCommunication,
  ): Promise<MailboxEnqueueResult> {
    const { recipient } = communication;
    return this.#forRecipient(recipient, async (client) => {
      const consumedTerminal =
        communication.type === InterAgentCommunicationTypes.FinalAnswer &&
        (await this.#exists(
          client,
          `SELECT EXISTS (
             SELECT 1 FROM ${this.#database.table('zukhruf_mailbox_consumed_terminal_ids')}
              WHERE communication_id = $1)`,
          [communication.id],
        ));
      if (!consumedTerminal) {
        await client.query(
          `INSERT INTO ${this.#database.table('zukhruf_mailbox_items')}
             (communication_id, recipient_chat_id, recipient_user_id, communication)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (communication_id) DO NOTHING`,
          [
            communication.id,
            recipient.chatId,
            recipient.userId,
            JSON.stringify(communication),
          ],
        );
      }
      return { recipientActive: await this.#isTurnActive(client, recipient) };
    });
  }

  override endTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<MailboxEndTurnResult> {
    return this.#forRecipient(recipient, async (client) => {
      const ended = await client.query(
        `DELETE FROM ${this.#database.table('zukhruf_mailbox_activity')}
          WHERE recipient_chat_id = $1
            AND recipient_user_id = $2
            AND turn_id = $3`,
        [recipient.chatId, recipient.userId, turnId],
      );
      return {
        hasPending: await this.#hasPending(client, recipient),
        turnEnded: ended.rowCount === 1,
      };
    });
  }

  override hasPending(recipient: ConversationId): Promise<boolean> {
    return this.#hasPending(this.#database, recipient);
  }

  override hasPendingTriggerTurn(recipient: ConversationId): Promise<boolean> {
    return this.#exists(
      this.#database,
      `SELECT EXISTS (
         SELECT 1 FROM ${this.#database.table('zukhruf_mailbox_items')}
          WHERE recipient_chat_id = $1
            AND recipient_user_id = $2
            AND communication @> '{"triggerTurn": true}')`,
      [recipient.chatId, recipient.userId],
    );
  }

  override drain(
    recipient: ConversationId,
  ): Promise<InterAgentCommunication[]> {
    return this.#drain(recipient, false);
  }

  override drainLeadingQueueOnly(
    recipient: ConversationId,
  ): Promise<InterAgentCommunication[]> {
    return this.#drain(recipient, true);
  }

  #drain(
    recipient: ConversationId,
    leadingQueueOnly: boolean,
  ): Promise<InterAgentCommunication[]> {
    return this.#forRecipient(recipient, async (client) => {
      const items = mailboxItemRowsSchema.parse(
        (
          await client.query(
            `SELECT sequence, communication
               FROM ${this.#database.table('zukhruf_mailbox_items')}
              WHERE recipient_chat_id = $1
                AND recipient_user_id = $2
              ORDER BY sequence`,
            [recipient.chatId, recipient.userId],
          )
        ).rows,
      );
      const firstTrigger = leadingQueueOnly
        ? items.findIndex(({ communication }) => communication.triggerTurn)
        : -1;
      const consumed =
        firstTrigger === -1 ? items : items.slice(0, firstTrigger);
      if (consumed.length === 0) return [];
      // Only terminal ids get durable tombstones: ordinary random-id mail
      // needs no permanent dedup state once it is consumed in FIFO order.
      await client.query(
        `INSERT INTO ${this.#database.table('zukhruf_mailbox_consumed_terminal_ids')} (communication_id)
         SELECT unnest($1::text[])
         ON CONFLICT (communication_id) DO NOTHING`,
        [
          consumed.flatMap(({ communication }) =>
            communication.type === InterAgentCommunicationTypes.FinalAnswer
              ? [communication.id]
              : [],
          ),
        ],
      );
      await client.query(
        `DELETE FROM ${this.#database.table('zukhruf_mailbox_items')}
          WHERE sequence = ANY($1::bigint[])`,
        [consumed.map(({ sequence }) => sequence)],
      );
      return consumed.map(({ communication }) => communication);
    });
  }

  #hasPending(
    queryable: Pick<PostgresTransaction, 'query'>,
    recipient: ConversationId,
  ): Promise<boolean> {
    return this.#exists(
      queryable,
      `SELECT EXISTS (
         SELECT 1 FROM ${this.#database.table('zukhruf_mailbox_items')}
          WHERE recipient_chat_id = $1 AND recipient_user_id = $2)`,
      [recipient.chatId, recipient.userId],
    );
  }

  #isTurnActive(
    client: PostgresTransaction,
    recipient: ConversationId,
  ): Promise<boolean> {
    return this.#exists(
      client,
      `SELECT EXISTS (
         SELECT 1 FROM ${this.#database.table('zukhruf_mailbox_activity')}
          WHERE recipient_chat_id = $1 AND recipient_user_id = $2)`,
      [recipient.chatId, recipient.userId],
    );
  }

  async #exists(
    queryable: Pick<PostgresTransaction, 'query'>,
    sql: string,
    params: unknown[],
  ): Promise<boolean> {
    const [{ exists }] = existsRowsSchema.parse(
      (await queryable.query(sql, params)).rows,
    );
    return exists;
  }
}
