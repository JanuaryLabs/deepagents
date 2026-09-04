import type { PgBoss } from 'pg-boss';

import type { ConversationId } from '../../mailbox/types.ts';
import { pgBossNotifications } from '../../queue/pg-boss-notifications.ts';
import type {
  ConversationStatusChangeHint,
  ConversationStatusChangeSource,
} from './change-source.ts';

export const DEFAULT_CONVERSATION_STATUS_CHANNEL =
  'zukhruf_conversation_status';

export interface PgBossConversationStatusChangeSourceOptions {
  channel?: string;
}

/**
 * Conversation status hints over the pg-boss database connection.
 *
 * `notify` raises `pg_notify` through `executeSql`; `subscribe` uses the
 * optional `IDatabase.listen`, which pg-boss implements for its pooled
 * Postgres driver (dedicated client, keepalive, re-LISTEN) and for the PGlite
 * adapter (in-process). A database without `listen` is rejected up front.
 */
export class PgBossConversationStatusChangeSource implements ConversationStatusChangeSource {
  readonly #boss: PgBoss;
  readonly #channel: string;

  constructor(
    boss: PgBoss,
    options: PgBossConversationStatusChangeSourceOptions = {},
  ) {
    this.#boss = boss;
    this.#channel = options.channel ?? DEFAULT_CONVERSATION_STATUS_CHANNEL;
  }

  async notify(conversation: ConversationId): Promise<void> {
    await this.#boss.getDb().executeSql('SELECT pg_notify($1, $2)', [
      this.#channel,
      JSON.stringify({
        chatId: conversation.chatId,
        userId: conversation.userId,
      }),
    ]);
  }

  async subscribe(
    signal: AbortSignal,
  ): Promise<AsyncIterable<ConversationStatusChangeHint>> {
    let notifications: AsyncIterable<
      { type: 'change'; value: ConversationId } | { type: 'reset' }
    >;
    try {
      notifications = await pgBossNotifications(
        this.#boss,
        this.#channel,
        parseHint,
        signal,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'pg-boss database does not support LISTEN'
      ) {
        throw new Error(
          'PgBossConversationStatusChangeSource requires a pg-boss database with LISTEN support',
          { cause: error },
        );
      }
      throw error;
    }
    return {
      async *[Symbol.asyncIterator]() {
        for await (const notification of notifications) {
          yield notification.type === 'reset'
            ? notification
            : { type: 'change', conversation: notification.value };
        }
      },
    };
  }
}

function parseHint(payload: string): ConversationId | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('chatId' in parsed) ||
    !('userId' in parsed) ||
    typeof parsed.chatId !== 'string' ||
    typeof parsed.userId !== 'string'
  ) {
    return undefined;
  }
  return { chatId: parsed.chatId, userId: parsed.userId };
}
