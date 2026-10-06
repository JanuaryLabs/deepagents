import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';

import { parseJson, parseJsonObject } from './columns.ts';
import STORE_DDL from './ddl.sqlite.sql';
import type {
  BranchData,
  BranchInfo,
  ChatData,
  ChatInfo,
  ChatUpdater,
  CheckpointData,
  CheckpointInfo,
  DeleteChatOptions,
  GraphBranch,
  GraphCheckpoint,
  GraphData,
  GraphNode,
  ListChatsOptions,
  MessageData,
  SearchOptions,
  SearchResult,
  StoredChatData,
} from './store.ts';
import { ContextStore } from './store.ts';

// Row shapes as node:sqlite returns them for ddl.sqlite.sql: INTEGER columns
// are numbers, TEXT columns strings, and JSON is stored as TEXT.

const chatColumns = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const storedChat = chatColumns.transform(toStoredChat);

const chatInfo = chatColumns
  .extend({ messageCount: z.number(), branchCount: z.number() })
  .transform((row): ChatInfo => ({
    ...toStoredChat(row),
    messageCount: row.messageCount,
    branchCount: row.branchCount,
  }));

const messageColumns = z.object({
  id: z.string(),
  chatId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  type: z.string().nullable(),
  data: z.string(),
  createdAt: z.number(),
});

const storedMessage = messageColumns.transform(toMessage);

const searchResult = messageColumns
  .extend({ rank: z.number(), snippet: z.string() })
  .transform((row): SearchResult => ({
    message: toMessage(row),
    rank: row.rank,
    snippet: row.snippet,
  }));

const storedBranch = z
  .object({
    id: z.string(),
    chatId: z.string(),
    name: z.string(),
    headMessageId: z.string().nullable(),
    isActive: z.number(),
    createdAt: z.number(),
  })
  .transform((row): BranchData => ({
    id: row.id,
    chatId: row.chatId,
    name: row.name,
    headMessageId: row.headMessageId,
    isActive: row.isActive === 1,
    createdAt: row.createdAt,
  }));

const branchInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    headMessageId: z.string().nullable(),
    isActive: z.number(),
    createdAt: z.number(),
    messageCount: z.number(),
  })
  .transform((row): BranchInfo => ({
    id: row.id,
    name: row.name,
    headMessageId: row.headMessageId,
    isActive: row.isActive === 1,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
  }));

const storedCheckpoint = z.object({
  id: z.string(),
  chatId: z.string(),
  name: z.string(),
  messageId: z.string(),
  createdAt: z.number(),
}) satisfies z.ZodType<CheckpointData>;

const checkpointInfo = z.object({
  id: z.string(),
  name: z.string(),
  messageId: z.string(),
  createdAt: z.number(),
}) satisfies z.ZodType<CheckpointInfo>;

const idRow = z.object({ id: z.string() });

const hasChildrenRow = z.object({ hasChildren: z.number() });

const graphMessageRow = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  data: z.string(),
  createdAt: z.number(),
});

const graphBranch = z
  .object({
    name: z.string(),
    headMessageId: z.string().nullable(),
    isActive: z.number(),
  })
  .transform((row): GraphBranch => ({
    name: row.name,
    headMessageId: row.headMessageId,
    isActive: row.isActive === 1,
  }));

const graphCheckpoint = z.object({
  name: z.string(),
  messageId: z.string(),
}) satisfies z.ZodType<GraphCheckpoint>;

function toStoredChat(row: z.output<typeof chatColumns>): StoredChatData {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title ?? undefined,
    metadata: row.metadata ? parseJsonObject(row.metadata) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: z.output<typeof messageColumns>): MessageData {
  return {
    id: row.id,
    chatId: row.chatId,
    parentId: row.parentId,
    name: row.name,
    type: row.type ?? undefined,
    data: parseJson(row.data),
    createdAt: row.createdAt,
  };
}

/**
 * SQLite-based context store using graph model.
 *
 * Uses node:sqlite's synchronous DatabaseSync for persistence.
 * Messages are stored as nodes in a DAG with parentId links.
 */
export class SqliteContextStore extends ContextStore {
  #db: DatabaseSync;
  #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  /**
   * Get or create a prepared statement.
   * Statements are cached for the lifetime of the store to avoid
   * repeated SQL parsing and compilation overhead.
   */
  #stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  constructor(pathOrDb: string | DatabaseSync) {
    super();
    this.#db =
      typeof pathOrDb === 'string' ? new DatabaseSync(pathOrDb) : pathOrDb;
    this.#db.exec(STORE_DDL);
  }

  /**
   * Execute a function within a transaction.
   * Automatically commits on success or rolls back on error.
   */
  #useTransaction<T>(
    fn: () => T,
    mode: 'deferred' | 'immediate' = 'deferred',
  ): T {
    this.#db.exec(
      mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN TRANSACTION',
    );
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLite can end a transaction itself after fatal I/O errors such as
      // SQLITE_FULL. A follow-up ROLLBACK then fails with "no transaction is
      // active"; never let that cleanup failure mask the original error.
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Best effort: preserve the operation error that triggered cleanup.
      }
      throw error;
    }
  }

  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  async createChat(chat: ChatData): Promise<StoredChatData> {
    return this.#useTransaction(() => {
      // Create chat (createdAt and updatedAt are auto-set by SQLite DEFAULT)
      const created = storedChat.parse(
        this.#db
          .prepare(
            `INSERT INTO chats (id, userId, title, metadata)
           VALUES (?, ?, ?, ?)
           RETURNING *`,
          )
          .get(
            chat.id,
            chat.userId,
            chat.title ?? null,
            chat.metadata ? JSON.stringify(chat.metadata) : null,
          ),
      );

      // Create "main" branch
      this.#db
        .prepare(
          `INSERT INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
           VALUES (?, ?, 'main', NULL, 1, ?)`,
        )
        .run(crypto.randomUUID(), chat.id, Date.now());

      return created;
    });
  }

  async upsertChat(chat: ChatData): Promise<StoredChatData> {
    return this.#useTransaction(() => {
      // Insert if not exists, no-op update if exists (to trigger RETURNING)
      const upserted = storedChat.parse(
        this.#db
          .prepare(
            `INSERT INTO chats (id, userId, title, metadata)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET id = excluded.id
           RETURNING *`,
          )
          .get(
            chat.id,
            chat.userId,
            chat.title ?? null,
            chat.metadata ? JSON.stringify(chat.metadata) : null,
          ),
      );

      // Ensure "main" branch exists (INSERT OR IGNORE uses UNIQUE(chatId, name) constraint)
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
           VALUES (?, ?, 'main', NULL, 1, ?)`,
        )
        .run(crypto.randomUUID(), chat.id, Date.now());

      return upserted;
    });
  }

  #getChat(chatId: string): StoredChatData | undefined {
    return storedChat
      .optional()
      .parse(this.#db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId));
  }

  async getChat(chatId: string): Promise<StoredChatData | undefined> {
    return this.#getChat(chatId);
  }

  async updateChat(
    chatId: string,
    update: ChatUpdater,
  ): Promise<StoredChatData> {
    return this.#useTransaction(() => {
      const current = this.#getChat(chatId);
      if (!current) {
        throw new Error(`updateChat: chat "${chatId}" not found`);
      }

      const updates = update(current);
      if (updates === undefined) return current;

      const setClauses: string[] = ["updatedAt = strftime('%s', 'now') * 1000"];
      const params: SQLInputValue[] = [];

      if (updates.title !== undefined) {
        setClauses.push('title = ?');
        params.push(updates.title);
      }
      if (updates.metadata !== undefined) {
        setClauses.push('metadata = ?');
        params.push(JSON.stringify(updates.metadata));
      }

      params.push(chatId);
      return storedChat.parse(
        this.#db
          .prepare(
            `UPDATE chats SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`,
          )
          .get(...params),
      );
    }, 'immediate');
  }

  async listChats(options?: ListChatsOptions): Promise<ChatInfo[]> {
    const params: SQLInputValue[] = [];
    const whereClauses: string[] = [];
    let limitClause = '';

    // Build WHERE clause for userId filter
    if (options?.userId) {
      whereClauses.push('c.userId = ?');
      params.push(options.userId);
    }

    // Build WHERE clause for metadata filter (exact match on top-level field)
    if (options?.metadata) {
      whereClauses.push(`json_extract(c.metadata, '$.' || ?) = ?`);
      params.push(options.metadata.key);
      params.push(
        typeof options.metadata.value === 'boolean'
          ? options.metadata.value
            ? 1
            : 0
          : options.metadata.value,
      );
    }

    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Build LIMIT/OFFSET clause
    if (options?.limit !== undefined) {
      limitClause = ' LIMIT ?';
      params.push(options.limit);
      if (options.offset !== undefined) {
        limitClause += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    return z.array(chatInfo).parse(
      this.#db
        .prepare(
          `SELECT
          c.id,
          c.userId,
          c.title,
          c.metadata,
          c.createdAt,
          c.updatedAt,
          COUNT(DISTINCT m.id) as messageCount,
          COUNT(DISTINCT b.id) as branchCount
        FROM chats c
        LEFT JOIN messages m ON m.chatId = c.id
        LEFT JOIN branches b ON b.chatId = c.id
        ${whereClause}
        GROUP BY c.id
        ORDER BY c.updatedAt DESC${limitClause}`,
        )
        .all(...params),
    );
  }

  async deleteChat(
    chatId: string,
    options?: DeleteChatOptions,
  ): Promise<boolean> {
    return this.#useTransaction(() => {
      // Get message IDs before deletion for FTS cleanup
      const messageIds = z
        .array(idRow)
        .parse(
          this.#db
            .prepare('SELECT id FROM messages WHERE chatId = ?')
            .all(chatId),
        );

      // Build the delete query with optional userId check
      let sql = 'DELETE FROM chats WHERE id = ?';
      const params: SQLInputValue[] = [chatId];

      if (options?.userId !== undefined) {
        sql += ' AND userId = ?';
        params.push(options.userId);
      }

      const result = this.#db.prepare(sql).run(...params);

      // Clean up FTS entries (CASCADE handles messages, branches, checkpoints)
      if (result.changes > 0 && messageIds.length > 0) {
        const placeholders = messageIds.map(() => '?').join(', ');
        this.#db
          .prepare(
            `DELETE FROM messages_fts WHERE messageId IN (${placeholders})`,
          )
          .run(...messageIds.map((m) => m.id));
      }

      return result.changes > 0;
    });
  }

  // ==========================================================================
  // Message Operations (Graph Nodes)
  // ==========================================================================

  #insertMessage(message: MessageData): void {
    // Prevent circular reference - a message cannot be its own parent
    if (message.parentId === message.id) {
      throw new Error(`Message ${message.id} cannot be its own parent`);
    }

    // Upsert message (using cached statement)
    this.#stmt(
      `INSERT INTO messages (id, chatId, parentId, name, type, data, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         data = excluded.data`,
    ).run(
      message.id,
      message.chatId,
      message.parentId,
      message.name,
      message.type ?? null,
      JSON.stringify(message.data),
      message.createdAt,
    );

    // Index in FTS for search
    const content =
      typeof message.data === 'string'
        ? message.data
        : JSON.stringify(message.data);

    // Delete existing FTS entry if any (for upsert), then insert new one
    this.#stmt(`DELETE FROM messages_fts WHERE messageId = ?`).run(message.id);
    this.#stmt(
      `INSERT INTO messages_fts(messageId, chatId, name, content)
       VALUES (?, ?, ?, ?)`,
    ).run(message.id, message.chatId, message.name, content);
  }

  async addMessage(message: MessageData): Promise<void> {
    this.#insertMessage(message);
  }

  override async addMessages(messages: MessageData[]): Promise<void> {
    if (messages.length === 0) return;

    this.#useTransaction(() => {
      for (const message of messages) {
        this.#insertMessage(message);
      }
    });
  }

  async setMessageParent(
    messageId: string,
    parentId: string | null,
  ): Promise<void> {
    if (parentId === messageId) {
      throw new Error(`Message ${messageId} cannot be its own parent`);
    }
    const result = this.#stmt(
      'UPDATE messages SET parentId = ? WHERE id = ?',
    ).run(parentId, messageId);
    if (result.changes === 0) {
      throw new Error(`Message ${messageId} not found`);
    }
  }

  async getMessage(messageId: string): Promise<MessageData | undefined> {
    return storedMessage
      .optional()
      .parse(this.#stmt('SELECT * FROM messages WHERE id = ?').get(messageId));
  }

  async getMessageChain(headId: string): Promise<MessageData[]> {
    // Walk up the parent chain using recursive CTE with depth tracking
    // The CTE walks from head (newest) to root (oldest), so we track depth
    // and order by depth DESC to get chronological order (root first)
    // Depth limit of 100000 prevents infinite loops from circular references
    return z.array(storedMessage).parse(
      this.#stmt(
        `WITH RECURSIVE chain AS (
        SELECT *, 0 as depth FROM messages WHERE id = ?
        UNION ALL
        SELECT m.*, c.depth + 1 FROM messages m
        INNER JOIN chain c ON m.id = c.parentId
        WHERE c.depth < 100000
      )
      SELECT * FROM chain
      ORDER BY depth DESC`,
      ).all(headId),
    );
  }

  async hasChildren(messageId: string): Promise<boolean> {
    const row = hasChildrenRow.parse(
      this.#stmt(
        'SELECT EXISTS(SELECT 1 FROM messages WHERE parentId = ?) as hasChildren',
      ).get(messageId),
    );

    return row.hasChildren === 1;
  }

  async getMessages(chatId: string): Promise<MessageData[]> {
    const chat = await this.getChat(chatId);
    if (!chat) {
      throw new Error(`Chat "${chatId}" not found`);
    }

    const activeBranch = await this.getActiveBranch(chatId);
    if (!activeBranch?.headMessageId) {
      return [];
    }

    return this.getMessageChain(activeBranch.headMessageId);
  }

  // ==========================================================================
  // Branch Operations
  // ==========================================================================

  async createBranch(branch: BranchData): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        branch.id,
        branch.chatId,
        branch.name,
        branch.headMessageId,
        branch.isActive ? 1 : 0,
        branch.createdAt,
      );
  }

  async getBranch(
    chatId: string,
    name: string,
  ): Promise<BranchData | undefined> {
    return storedBranch
      .optional()
      .parse(
        this.#db
          .prepare('SELECT * FROM branches WHERE chatId = ? AND name = ?')
          .get(chatId, name),
      );
  }

  async getActiveBranch(chatId: string): Promise<BranchData | undefined> {
    return storedBranch
      .optional()
      .parse(
        this.#stmt(
          'SELECT * FROM branches WHERE chatId = ? AND isActive = 1',
        ).get(chatId),
      );
  }

  async setActiveBranch(chatId: string, branchId: string): Promise<void> {
    // Deactivate all branches for this chat
    this.#db
      .prepare('UPDATE branches SET isActive = 0 WHERE chatId = ?')
      .run(chatId);

    // Activate the specified branch
    this.#db
      .prepare('UPDATE branches SET isActive = 1 WHERE id = ?')
      .run(branchId);
  }

  async updateBranchHead(
    branchId: string,
    messageId: string | null,
    expectedHeadMessageId: string | null,
  ): Promise<boolean> {
    const result = this.#stmt(
      'UPDATE branches SET headMessageId = ? WHERE id = ? AND headMessageId IS ?',
    ).run(messageId, branchId, expectedHeadMessageId);
    return result.changes > 0;
  }

  async listBranches(chatId: string): Promise<BranchInfo[]> {
    // Single query with correlated subquery to count messages per branch
    // Eliminates N+1 pattern (was: 1 query + N recursive CTEs)
    return z.array(branchInfo).parse(
      this.#db
        .prepare(
          `SELECT
          b.id,
          b.name,
          b.headMessageId,
          b.isActive,
          b.createdAt,
          COALESCE(
            (
              WITH RECURSIVE chain AS (
                SELECT id, parentId FROM messages WHERE id = b.headMessageId
                UNION ALL
                SELECT m.id, m.parentId FROM messages m
                INNER JOIN chain c ON m.id = c.parentId
              )
              SELECT COUNT(*) FROM chain
            ),
            0
          ) as messageCount
        FROM branches b
        WHERE b.chatId = ?
        ORDER BY b.createdAt ASC`,
        )
        .all(chatId),
    );
  }

  // ==========================================================================
  // Checkpoint Operations
  // ==========================================================================

  async createCheckpoint(checkpoint: CheckpointData): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO checkpoints (id, chatId, name, messageId, createdAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chatId, name) DO UPDATE SET
           messageId = excluded.messageId,
           createdAt = excluded.createdAt`,
      )
      .run(
        checkpoint.id,
        checkpoint.chatId,
        checkpoint.name,
        checkpoint.messageId,
        checkpoint.createdAt,
      );
  }

  async getCheckpoint(
    chatId: string,
    name: string,
  ): Promise<CheckpointData | undefined> {
    return storedCheckpoint
      .optional()
      .parse(
        this.#db
          .prepare('SELECT * FROM checkpoints WHERE chatId = ? AND name = ?')
          .get(chatId, name),
      );
  }

  async listCheckpoints(chatId: string): Promise<CheckpointInfo[]> {
    return z.array(checkpointInfo).parse(
      this.#db
        .prepare(
          `SELECT id, name, messageId, createdAt
         FROM checkpoints
         WHERE chatId = ?
         ORDER BY createdAt DESC`,
        )
        .all(chatId),
    );
  }

  async deleteCheckpoint(chatId: string, name: string): Promise<void> {
    this.#db
      .prepare('DELETE FROM checkpoints WHERE chatId = ? AND name = ?')
      .run(chatId, name);
  }

  // ==========================================================================
  // Search Operations
  // ==========================================================================

  async searchMessages(
    chatId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 20;
    const roles = options?.roles;

    // Build the query dynamically based on options
    let sql = `
      SELECT
        m.id,
        m.chatId,
        m.parentId,
        m.name,
        m.type,
        m.data,
        m.createdAt,
        fts.rank,
        snippet(messages_fts, 3, '<mark>', '</mark>', '...', 32) as snippet
      FROM messages_fts fts
      JOIN messages m ON m.id = fts.messageId
      WHERE messages_fts MATCH ?
        AND fts.chatId = ?
    `;

    const params: SQLInputValue[] = [query, chatId];

    if (roles && roles.length > 0) {
      const placeholders = roles.map(() => '?').join(', ');
      sql += ` AND fts.name IN (${placeholders})`;
      params.push(...roles);
    }

    sql += ' ORDER BY fts.rank LIMIT ?';
    params.push(limit);

    return z.array(searchResult).parse(this.#db.prepare(sql).all(...params));
  }

  // ==========================================================================
  // Visualization Operations
  // ==========================================================================

  async getGraph(chatId: string): Promise<GraphData> {
    // Get all messages for complete graph
    const messageRows = z.array(graphMessageRow).parse(
      this.#db
        .prepare(
          `SELECT id, parentId, name, data, createdAt
         FROM messages
         WHERE chatId = ?
         ORDER BY createdAt ASC`,
        )
        .all(chatId),
    );

    const nodes: GraphNode[] = messageRows.map((row) => {
      const data = JSON.parse(row.data);
      const content =
        typeof data === 'string'
          ? data
          : Array.isArray(data.parts)
            ? data.parts
                .filter((p: { type: string }) => p.type === 'text')
                .map((p: { text: string }) => p.text)
                .join(' ')
            : JSON.stringify(data);
      return {
        id: row.id,
        parentId: row.parentId,
        role: row.name,
        content: content.length > 50 ? content.slice(0, 50) + '...' : content,
        createdAt: row.createdAt,
      };
    });

    // Get all branches
    const branches = z.array(graphBranch).parse(
      this.#db
        .prepare(
          `SELECT name, headMessageId, isActive
         FROM branches
         WHERE chatId = ?
         ORDER BY createdAt ASC`,
        )
        .all(chatId),
    );

    // Get all checkpoints
    const checkpoints = z.array(graphCheckpoint).parse(
      this.#db
        .prepare(
          `SELECT name, messageId
         FROM checkpoints
         WHERE chatId = ?
         ORDER BY createdAt ASC`,
        )
        .all(chatId),
    );

    return {
      chatId,
      nodes,
      branches,
      checkpoints,
    };
  }
}
