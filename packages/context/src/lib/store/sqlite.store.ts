import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  BranchData,
  BranchInfo,
  ChatData,
  ChatInfo,
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

const STORE_DDL = `
-- Chats table
-- createdAt/updatedAt: DEFAULT for insert, inline SET for updates
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  title TEXT,
  metadata TEXT,
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_chats_updatedAt ON chats(updatedAt);
CREATE INDEX IF NOT EXISTS idx_chats_userId ON chats(userId);

-- Messages table (nodes in the DAG)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  parentId TEXT,
  name TEXT NOT NULL,
  type TEXT,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (parentId) REFERENCES messages(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);
CREATE INDEX IF NOT EXISTS idx_messages_parentId ON messages(parentId);

-- Branches table (pointers to head messages)
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  headMessageId TEXT,
  isActive INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (headMessageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS idx_branches_chatId ON branches(chatId);

-- Checkpoints table (pointers to message nodes)
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  name TEXT NOT NULL,
  messageId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (chatId) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (messageId) REFERENCES messages(id),
  UNIQUE(chatId, name)
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_chatId ON checkpoints(chatId);

-- FTS5 virtual table for full-text search
-- messageId/chatId/name are UNINDEXED (stored but not searchable, used for filtering/joining)
-- Only 'content' is indexed for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  messageId UNINDEXED,
  chatId UNINDEXED,
  name UNINDEXED,
  content,
  tokenize='porter unicode61'
);
`;

/**
 * SQLite-based context store using graph model.
 *
 * Uses node:sqlite's synchronous DatabaseSync for persistence.
 * Messages are stored as nodes in a DAG with parentId links.
 */
export class SqliteContextStore extends ContextStore {
  #db: DatabaseSync;

  constructor(path: string) {
    super();
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(STORE_DDL);
  }

  /**
   * Execute a function within a transaction.
   * Automatically commits on success or rolls back on error.
   */
  #useTransaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  async createChat(chat: ChatData): Promise<void> {
    this.#useTransaction(() => {
      // Create chat (createdAt and updatedAt are auto-set by SQLite DEFAULT)
      this.#db
        .prepare(
          `INSERT INTO chats (id, userId, title, metadata)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          chat.id,
          chat.userId,
          chat.title ?? null,
          chat.metadata ? JSON.stringify(chat.metadata) : null,
        );

      // Create "main" branch
      this.#db
        .prepare(
          `INSERT INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
           VALUES (?, ?, 'main', NULL, 1, ?)`,
        )
        .run(crypto.randomUUID(), chat.id, Date.now());
    });
  }

  async upsertChat(chat: ChatData): Promise<StoredChatData> {
    return this.#useTransaction(() => {
      // Insert if not exists, no-op update if exists (to trigger RETURNING)
      const row = this.#db
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
        ) as {
        id: string;
        userId: string;
        title: string | null;
        metadata: string | null;
        createdAt: number;
        updatedAt: number;
      };

      // Ensure "main" branch exists (INSERT OR IGNORE uses UNIQUE(chatId, name) constraint)
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
           VALUES (?, ?, 'main', NULL, 1, ?)`,
        )
        .run(crypto.randomUUID(), chat.id, Date.now());

      return {
        id: row.id,
        userId: row.userId,
        title: row.title ?? undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async getChat(chatId: string): Promise<StoredChatData | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM chats WHERE id = ?')
      .get(chatId) as
      | {
          id: string;
          userId: string;
          title: string | null;
          metadata: string | null;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      userId: row.userId,
      title: row.title ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async updateChat(
    chatId: string,
    updates: Partial<Pick<ChatData, 'title' | 'metadata'>>,
  ): Promise<StoredChatData> {
    const setClauses: string[] = ["updatedAt = strftime('%s', 'now') * 1000"];
    const params: SQLInputValue[] = [];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      params.push(updates.title ?? null);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }

    params.push(chatId);
    const row = this.#db
      .prepare(
        `UPDATE chats SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`,
      )
      .get(...params) as {
      id: string;
      userId: string;
      title: string | null;
      metadata: string | null;
      createdAt: number;
      updatedAt: number;
    };

    return {
      id: row.id,
      userId: row.userId,
      title: row.title ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listChats(options?: ListChatsOptions): Promise<ChatInfo[]> {
    const params: SQLInputValue[] = [];
    let whereClause = '';
    let limitClause = '';

    // Build WHERE clause for userId filter
    if (options?.userId) {
      whereClause = 'WHERE c.userId = ?';
      params.push(options.userId);
    }

    // Build LIMIT/OFFSET clause
    if (options?.limit !== undefined) {
      limitClause = ' LIMIT ?';
      params.push(options.limit);
      if (options.offset !== undefined) {
        limitClause += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    const rows = this.#db
      .prepare(
        `SELECT
          c.id,
          c.userId,
          c.title,
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
      .all(...params) as {
      id: string;
      userId: string;
      title: string | null;
      createdAt: number;
      updatedAt: number;
      messageCount: number;
      branchCount: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      title: row.title ?? undefined,
      messageCount: row.messageCount,
      branchCount: row.branchCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async deleteChat(
    chatId: string,
    options?: DeleteChatOptions,
  ): Promise<boolean> {
    return this.#useTransaction(() => {
      // Get message IDs before deletion for FTS cleanup
      const messageIds = this.#db
        .prepare('SELECT id FROM messages WHERE chatId = ?')
        .all(chatId) as { id: string }[];

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

  async addMessage(message: MessageData): Promise<void> {
    // Upsert the message
    this.#db
      .prepare(
        `INSERT INTO messages (id, chatId, parentId, name, type, data, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           parentId = excluded.parentId,
           name = excluded.name,
           type = excluded.type,
           data = excluded.data`,
      )
      .run(
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
    this.#db
      .prepare(`DELETE FROM messages_fts WHERE messageId = ?`)
      .run(message.id);
    this.#db
      .prepare(
        `INSERT INTO messages_fts(messageId, chatId, name, content)
         VALUES (?, ?, ?, ?)`,
      )
      .run(message.id, message.chatId, message.name, content);
  }

  async getMessage(messageId: string): Promise<MessageData | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(messageId) as
      | {
          id: string;
          chatId: string;
          parentId: string | null;
          name: string;
          type: string | null;
          data: string;
          createdAt: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      chatId: row.chatId,
      parentId: row.parentId,
      name: row.name,
      type: row.type ?? undefined,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
    };
  }

  async getMessageChain(headId: string): Promise<MessageData[]> {
    // Walk up the parent chain using recursive CTE with depth tracking
    // The CTE walks from head (newest) to root (oldest), so we track depth
    // and order by depth DESC to get chronological order (root first)
    const rows = this.#db
      .prepare(
        `WITH RECURSIVE chain AS (
          SELECT *, 0 as depth FROM messages WHERE id = ?
          UNION ALL
          SELECT m.*, c.depth + 1 FROM messages m
          INNER JOIN chain c ON m.id = c.parentId
        )
        SELECT * FROM chain
        ORDER BY depth DESC`,
      )
      .all(headId) as {
      id: string;
      chatId: string;
      parentId: string | null;
      name: string;
      type: string | null;
      data: string;
      createdAt: number;
      depth: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      parentId: row.parentId,
      name: row.name,
      type: row.type ?? undefined,
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
    }));
  }

  async hasChildren(messageId: string): Promise<boolean> {
    const row = this.#db
      .prepare(
        'SELECT EXISTS(SELECT 1 FROM messages WHERE parentId = ?) as hasChildren',
      )
      .get(messageId) as { hasChildren: number };

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
    const row = this.#db
      .prepare('SELECT * FROM branches WHERE chatId = ? AND name = ?')
      .get(chatId, name) as
      | {
          id: string;
          chatId: string;
          name: string;
          headMessageId: string | null;
          isActive: number;
          createdAt: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      chatId: row.chatId,
      name: row.name,
      headMessageId: row.headMessageId,
      isActive: row.isActive === 1,
      createdAt: row.createdAt,
    };
  }

  async getActiveBranch(chatId: string): Promise<BranchData | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM branches WHERE chatId = ? AND isActive = 1')
      .get(chatId) as
      | {
          id: string;
          chatId: string;
          name: string;
          headMessageId: string | null;
          isActive: number;
          createdAt: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      chatId: row.chatId,
      name: row.name,
      headMessageId: row.headMessageId,
      isActive: true,
      createdAt: row.createdAt,
    };
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
  ): Promise<void> {
    this.#db
      .prepare('UPDATE branches SET headMessageId = ? WHERE id = ?')
      .run(messageId, branchId);
  }

  async listBranches(chatId: string): Promise<BranchInfo[]> {
    // Get branches with message count by walking the chain
    const branches = this.#db
      .prepare(
        `SELECT
          b.id,
          b.name,
          b.headMessageId,
          b.isActive,
          b.createdAt
        FROM branches b
        WHERE b.chatId = ?
        ORDER BY b.createdAt ASC`,
      )
      .all(chatId) as {
      id: string;
      name: string;
      headMessageId: string | null;
      isActive: number;
      createdAt: number;
    }[];

    // For each branch, count messages in the chain
    const result: BranchInfo[] = [];
    for (const branch of branches) {
      let messageCount = 0;
      if (branch.headMessageId) {
        const countRow = this.#db
          .prepare(
            `WITH RECURSIVE chain AS (
              SELECT id, parentId FROM messages WHERE id = ?
              UNION ALL
              SELECT m.id, m.parentId FROM messages m
              INNER JOIN chain c ON m.id = c.parentId
            )
            SELECT COUNT(*) as count FROM chain`,
          )
          .get(branch.headMessageId) as { count: number };
        messageCount = countRow.count;
      }

      result.push({
        id: branch.id,
        name: branch.name,
        headMessageId: branch.headMessageId,
        isActive: branch.isActive === 1,
        messageCount,
        createdAt: branch.createdAt,
      });
    }

    return result;
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
    const row = this.#db
      .prepare('SELECT * FROM checkpoints WHERE chatId = ? AND name = ?')
      .get(chatId, name) as
      | {
          id: string;
          chatId: string;
          name: string;
          messageId: string;
          createdAt: number;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      chatId: row.chatId,
      name: row.name,
      messageId: row.messageId,
      createdAt: row.createdAt,
    };
  }

  async listCheckpoints(chatId: string): Promise<CheckpointInfo[]> {
    const rows = this.#db
      .prepare(
        `SELECT id, name, messageId, createdAt
         FROM checkpoints
         WHERE chatId = ?
         ORDER BY createdAt DESC`,
      )
      .all(chatId) as {
      id: string;
      name: string;
      messageId: string;
      createdAt: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      messageId: row.messageId,
      createdAt: row.createdAt,
    }));
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

    const rows = this.#db.prepare(sql).all(...params) as {
      id: string;
      chatId: string;
      parentId: string | null;
      name: string;
      type: string | null;
      data: string;
      createdAt: number;
      rank: number;
      snippet: string;
    }[];

    return rows.map((row) => ({
      message: {
        id: row.id,
        chatId: row.chatId,
        parentId: row.parentId,
        name: row.name,
        type: row.type ?? undefined,
        data: JSON.parse(row.data),
        createdAt: row.createdAt,
      },
      rank: row.rank,
      snippet: row.snippet,
    }));
  }

  // ==========================================================================
  // Visualization Operations
  // ==========================================================================

  async getGraph(chatId: string): Promise<GraphData> {
    // Get all messages for complete graph
    const messageRows = this.#db
      .prepare(
        `SELECT id, parentId, name, data, createdAt
         FROM messages
         WHERE chatId = ?
         ORDER BY createdAt ASC`,
      )
      .all(chatId) as {
      id: string;
      parentId: string | null;
      name: string;
      data: string;
      createdAt: number;
    }[];

    const nodes: GraphNode[] = messageRows.map((row) => {
      const data = JSON.parse(row.data);
      const content = typeof data === 'string' ? data : JSON.stringify(data);
      return {
        id: row.id,
        parentId: row.parentId,
        role: row.name,
        content: content.length > 50 ? content.slice(0, 50) + '...' : content,
        createdAt: row.createdAt,
      };
    });

    // Get all branches
    const branchRows = this.#db
      .prepare(
        `SELECT name, headMessageId, isActive
         FROM branches
         WHERE chatId = ?
         ORDER BY createdAt ASC`,
      )
      .all(chatId) as {
      name: string;
      headMessageId: string | null;
      isActive: number;
    }[];

    const branches: GraphBranch[] = branchRows.map((row) => ({
      name: row.name,
      headMessageId: row.headMessageId,
      isActive: row.isActive === 1,
    }));

    // Get all checkpoints
    const checkpointRows = this.#db
      .prepare(
        `SELECT name, messageId
         FROM checkpoints
         WHERE chatId = ?
         ORDER BY createdAt ASC`,
      )
      .all(chatId) as {
      name: string;
      messageId: string;
    }[];

    const checkpoints: GraphCheckpoint[] = checkpointRows.map((row) => ({
      name: row.name,
      messageId: row.messageId,
    }));

    return {
      chatId,
      nodes,
      branches,
      checkpoints,
    };
  }
}
