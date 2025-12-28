import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  BranchData,
  BranchInfo,
  ChatData,
  ChatInfo,
  CheckpointData,
  CheckpointInfo,
  GraphBranch,
  GraphCheckpoint,
  GraphData,
  GraphNode,
  MessageData,
} from './store.ts';
import { ContextStore } from './store.ts';

const STORE_DDL = `
-- Chats table
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT,
  metadata TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_updatedAt ON chats(updatedAt);

-- Messages table (nodes in the DAG)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chatId TEXT NOT NULL,
  parentId TEXT,
  name TEXT NOT NULL,
  type TEXT,
  data TEXT NOT NULL,
  persist INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
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

  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  async createChat(chat: ChatData): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO chats (id, title, metadata, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        chat.id,
        chat.title ?? null,
        chat.metadata ? JSON.stringify(chat.metadata) : null,
        chat.createdAt,
        chat.updatedAt,
      );
  }

  async getChat(chatId: string): Promise<ChatData | undefined> {
    const row = this.#db
      .prepare('SELECT * FROM chats WHERE id = ?')
      .get(chatId) as
      | {
          id: string;
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
      title: row.title ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async updateChat(
    chatId: string,
    updates: Partial<Pick<ChatData, 'title' | 'metadata' | 'updatedAt'>>,
  ): Promise<void> {
    const setClauses: string[] = [];
    const params: SQLInputValue[] = [];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      params.push(updates.title ?? null);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.updatedAt !== undefined) {
      setClauses.push('updatedAt = ?');
      params.push(updates.updatedAt);
    }

    if (setClauses.length === 0) {
      return;
    }

    params.push(chatId);
    this.#db
      .prepare(`UPDATE chats SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...params);
  }

  async listChats(): Promise<ChatInfo[]> {
    const rows = this.#db
      .prepare(
        `SELECT
          c.id,
          c.title,
          c.createdAt,
          c.updatedAt,
          COUNT(DISTINCT m.id) as messageCount,
          COUNT(DISTINCT b.id) as branchCount
        FROM chats c
        LEFT JOIN messages m ON m.chatId = c.id AND m.deleted = 0
        LEFT JOIN branches b ON b.chatId = c.id
        GROUP BY c.id
        ORDER BY c.updatedAt DESC`,
      )
      .all() as {
      id: string;
      title: string | null;
      createdAt: number;
      updatedAt: number;
      messageCount: number;
      branchCount: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? undefined,
      messageCount: row.messageCount,
      branchCount: row.branchCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  // ==========================================================================
  // Message Operations (Graph Nodes)
  // ==========================================================================

  async addMessage(message: MessageData): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO messages (id, chatId, parentId, name, type, data, persist, deleted, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.chatId,
        message.parentId,
        message.name,
        message.type ?? null,
        JSON.stringify(message.data),
        message.persist ? 1 : 0,
        message.deleted ? 1 : 0,
        message.createdAt,
      );
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
          persist: number;
          deleted: number;
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
      persist: row.persist === 1,
      deleted: row.deleted === 1,
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
        SELECT * FROM chain WHERE deleted = 0
        ORDER BY depth DESC`,
      )
      .all(headId) as {
      id: string;
      chatId: string;
      parentId: string | null;
      name: string;
      type: string | null;
      data: string;
      persist: number;
      deleted: number;
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
      persist: row.persist === 1,
      deleted: row.deleted === 1,
      createdAt: row.createdAt,
    }));
  }

  async softDeleteMessage(messageId: string): Promise<void> {
    this.#db
      .prepare('UPDATE messages SET deleted = 1 WHERE id = ?')
      .run(messageId);
  }

  async hasChildren(messageId: string): Promise<boolean> {
    const row = this.#db
      .prepare(
        'SELECT EXISTS(SELECT 1 FROM messages WHERE parentId = ? AND deleted = 0) as hasChildren',
      )
      .get(messageId) as { hasChildren: number };

    return row.hasChildren === 1;
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
  // Visualization Operations
  // ==========================================================================

  async getGraph(chatId: string): Promise<GraphData> {
    // Get all messages (including deleted) for complete graph
    const messageRows = this.#db
      .prepare(
        `SELECT id, parentId, name, data, createdAt, deleted
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
      deleted: number;
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
        deleted: row.deleted === 1,
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
