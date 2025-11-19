import { DatabaseSync } from 'node:sqlite';

import historyDDL from './history.sqlite.sql';
import {
  type Chat,
  type CreateChatParams,
  type CreateMessageParams,
  History,
  type Message,
  type UpdateChatParams,
} from './history.ts';

export class SqliteHistory extends History {
  #db: DatabaseSync;

  constructor(path: string) {
    super();
    this.#db = new DatabaseSync(path);
    this.#db.exec(historyDDL);
  }

  async listChats(userId: string): Promise<Chat[]> {
    return this.#db
      .prepare(`SELECT * FROM chats WHERE "userId" = ?`)
      .all(userId) as unknown as Chat[];
  }

  async getChat(chatId: string): Promise<Chat | null> {
    const rows = this.#db
      .prepare(
        `SELECT
          c.id as chatId, c."userId", c.title,
          m.id as messageId, m.role, m."createdAt", m.content
        FROM chats c
        LEFT JOIN messages m ON m."chatId" = c.id
        WHERE c.id = ?
        ORDER BY m."createdAt" ASC`,
      )
      .all(chatId) as unknown as Array<{
      chatId: string;
      userId: string;
      title: string | null;
      messageId: string | null;
      role: string;
      createdAt: string;
      content: string;
    }>;

    if (!rows.length) return null;

    const firstRow = rows[0];
    const chat: Chat = {
      id: firstRow.chatId,
      userId: firstRow.userId,
      title: firstRow.title,
      messages: [],
    };

    for (const row of rows) {
      if (row.messageId) {
        chat.messages.push({
          id: row.messageId,
          chatId: firstRow.chatId,
          role: row.role as string,
          createdAt: row.createdAt as string,
          content: JSON.parse(row.content),
        });
      }
    }

    return chat;
  }

  async createChat(chat: CreateChatParams): Promise<Chat> {
    this.#db
      .prepare(`INSERT INTO chats (id, "userId", title) VALUES (?, ?, ?)`)
      .run(chat.id, chat.userId, chat.title || null);
    return chat as Chat;
  }

  async upsertChat(chat: CreateChatParams) {
    this.#db
      .prepare(
        `INSERT INTO chats (id, "userId", title) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, "userId" = excluded."userId"`,
      )
      .run(chat.id, chat.userId, chat.title || null);
    return this.getChat(chat.id) as Promise<Chat>;
  }

  async deleteChat(chatId: string): Promise<void> {
    this.#db.prepare(`DELETE FROM chats WHERE id = ?`).run(chatId);
  }

  async updateChat(chatId: string, updates: UpdateChatParams): Promise<void> {
    if (updates.title !== undefined) {
      this.#db
        .prepare(`UPDATE chats SET title = ? WHERE id = ?`)
        .run(updates.title, chatId);
    }
  }

  async addMessage(message: CreateMessageParams): Promise<void> {
    const createdAt = message.createdAt
      ? message.createdAt.toISOString()
      : new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO messages (id, "chatId", role, "createdAt", content) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.chatId,
        message.role,
        createdAt,
        JSON.stringify(message.content),
      );
  }

  async upsertMessage(message: CreateMessageParams): Promise<Message> {
    const createdAt = message.createdAt
      ? message.createdAt.toISOString()
      : new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO messages (id, "chatId", role, "createdAt", content) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET "chatId" = excluded."chatId", role = excluded.role, "createdAt" = excluded."createdAt", content = excluded.content`,
      )
      .run(
        message.id,
        message.chatId,
        message.role,
        createdAt,
        JSON.stringify(message.content),
      );
    return {
      ...message,
      createdAt,
    };
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.#db.prepare(`DELETE FROM messages WHERE id = ?`).run(messageId);
  }
}
