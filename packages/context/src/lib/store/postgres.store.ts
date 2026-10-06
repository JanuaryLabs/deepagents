import { createRequire } from 'node:module';
import type { Pool, PoolClient, PoolConfig } from 'pg';
import { z } from 'zod';

import { bigintColumn, jsonObject } from './columns.ts';
import { storeDDL } from './ddl.postgres.ts';
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

// Row shapes as pg returns them for ddl.postgres.ts: unquoted identifiers fold
// to lowercase, BIGINT and COUNT() arrive as strings (see bigintColumn), JSONB
// arrives parsed, and BOOLEAN as a boolean.

const chatColumns = z.object({
  id: z.string(),
  userid: z.string(),
  title: z.string().nullable(),
  metadata: jsonObject.nullable(),
  createdat: bigintColumn,
  updatedat: bigintColumn,
});

const storedChat = chatColumns.transform(toStoredChat);

const chatInfo = chatColumns
  .extend({ messagecount: bigintColumn, branchcount: bigintColumn })
  .transform((row): ChatInfo => ({
    ...toStoredChat(row),
    messageCount: row.messagecount,
    branchCount: row.branchcount,
  }));

const messageColumns = z.object({
  id: z.string(),
  chatid: z.string(),
  parentid: z.string().nullable(),
  name: z.string(),
  type: z.string().nullable(),
  data: z.unknown(),
  createdat: bigintColumn,
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
    chatid: z.string(),
    name: z.string(),
    headmessageid: z.string().nullable(),
    isactive: z.boolean(),
    createdat: bigintColumn,
  })
  .transform((row): BranchData => ({
    id: row.id,
    chatId: row.chatid,
    name: row.name,
    headMessageId: row.headmessageid,
    isActive: row.isactive,
    createdAt: row.createdat,
  }));

const branchRow = z.object({
  id: z.string(),
  name: z.string(),
  headmessageid: z.string().nullable(),
  isactive: z.boolean(),
  createdat: bigintColumn,
});

const storedCheckpoint = z
  .object({
    id: z.string(),
    chatid: z.string(),
    name: z.string(),
    messageid: z.string(),
    createdat: bigintColumn,
  })
  .transform((row): CheckpointData => ({
    id: row.id,
    chatId: row.chatid,
    name: row.name,
    messageId: row.messageid,
    createdAt: row.createdat,
  }));

const checkpointInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    messageid: z.string(),
    createdat: bigintColumn,
  })
  .transform((row): CheckpointInfo => ({
    id: row.id,
    name: row.name,
    messageId: row.messageid,
    createdAt: row.createdat,
  }));

const idRow = z.object({ id: z.string() });

const existsRow = z.object({ exists: z.boolean() });

const countRow = z.object({ count: bigintColumn });

const graphMessageRow = z.object({
  id: z.string(),
  parentid: z.string().nullable(),
  name: z.string(),
  data: z.unknown(),
  createdat: bigintColumn,
});

const graphBranch = z
  .object({
    name: z.string(),
    headmessageid: z.string().nullable(),
    isactive: z.boolean(),
  })
  .transform((row): GraphBranch => ({
    name: row.name,
    headMessageId: row.headmessageid,
    isActive: row.isactive,
  }));

const graphCheckpoint = z
  .object({ name: z.string(), messageid: z.string() })
  .transform((row): GraphCheckpoint => ({
    name: row.name,
    messageId: row.messageid,
  }));

function toStoredChat(row: z.output<typeof chatColumns>): StoredChatData {
  return {
    id: row.id,
    userId: row.userid,
    title: row.title ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdat,
    updatedAt: row.updatedat,
  };
}

function toMessage(row: z.output<typeof messageColumns>): MessageData {
  return {
    id: row.id,
    chatId: row.chatid,
    parentId: row.parentid,
    name: row.name,
    type: row.type ?? undefined,
    data: row.data,
    createdAt: row.createdat,
  };
}

export interface PostgresStoreOptions {
  /**
   * PostgreSQL connection pool configuration.
   * Can be a connection string, PoolConfig object, or existing Pool instance.
   */
  pool: Pool | PoolConfig | string;
  /**
   * PostgreSQL schema to scope all tables under.
   * Defaults to 'public'.
   */
  schema?: string;
}

/**
 * PostgreSQL-based context store using graph model.
 *
 * Uses pg Pool for connection management.
 * Messages are stored as nodes in a DAG with parentId links.
 *
 * Requires `pg` package to be installed:
 * ```
 * npm install pg
 * ```
 */
export class PostgresContextStore extends ContextStore {
  #pool: Pool;
  #schema: string;
  #ownsPool: boolean;
  #isInitialized = false;

  constructor(options: PostgresStoreOptions) {
    super();
    const schema = options.schema ?? 'public';
    if (!/^[a-zA-Z_]\w*$/.test(schema)) {
      throw new Error(`Invalid schema name: "${schema}"`);
    }
    this.#schema = schema;
    const pg = PostgresContextStore.#requirePg();
    if (options.pool instanceof pg.Pool) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool =
        typeof options.pool === 'string'
          ? new pg.Pool({ connectionString: options.pool })
          : new pg.Pool(options.pool);
      this.#ownsPool = true;
    }
  }

  static #requirePg(): typeof import('pg') {
    try {
      const require = createRequire(import.meta.url);
      return require('pg');
    } catch {
      throw new Error(
        'PostgresContextStore requires the "pg" package. Install it with: npm install pg',
      );
    }
  }

  #t(name: string): string {
    return `"${this.#schema}"."${name}"`;
  }

  async initialize(): Promise<void> {
    const ddl = storeDDL(this.#schema);
    await this.#pool.query(ddl);
    this.#isInitialized = true;
  }

  #ensureInitialized(): void {
    if (!this.#isInitialized) {
      throw new Error(
        'PostgresContextStore not initialized. Call await store.initialize() after construction.',
      );
    }
  }

  /**
   * Execute a function within a transaction.
   * Automatically commits on success or rolls back on error.
   */
  async #useTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#ensureInitialized();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Execute a query using the pool (no transaction).
   */
  async #query(sql: string, params?: unknown[]): Promise<unknown[]> {
    this.#ensureInitialized();
    const result = await this.#pool.query(sql, params);
    return result.rows;
  }

  /**
   * Execute a query using the pool and parse every returned row.
   */
  async #rows<Row extends z.ZodType>(
    row: Row,
    sql: string,
    params?: unknown[],
  ): Promise<z.output<Row>[]> {
    return z.array(row).parse(await this.#query(sql, params));
  }

  /**
   * Close the pool connection.
   * Call this when done with the store.
   */
  async close(): Promise<void> {
    if (this.#ownsPool) {
      await this.#pool.end();
    }
  }

  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  async createChat(chat: ChatData): Promise<StoredChatData> {
    return this.#useTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ${this.#t('chats')} (id, userId, title, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          chat.id,
          chat.userId,
          chat.title ?? null,
          chat.metadata ? JSON.stringify(chat.metadata) : null,
        ],
      );
      const created = storedChat.parse(result.rows[0]);

      await client.query(
        `INSERT INTO ${this.#t('branches')} (id, chatId, name, headMessageId, isActive, createdAt)
         VALUES ($1, $2, 'main', NULL, TRUE, $3)`,
        [crypto.randomUUID(), chat.id, Date.now()],
      );

      return created;
    });
  }

  async upsertChat(chat: ChatData): Promise<StoredChatData> {
    return this.#useTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO ${this.#t('chats')} (id, userId, title, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(id) DO UPDATE SET id = EXCLUDED.id
         RETURNING *`,
        [
          chat.id,
          chat.userId,
          chat.title ?? null,
          chat.metadata ? JSON.stringify(chat.metadata) : null,
        ],
      );
      const upserted = storedChat.parse(result.rows[0]);

      await client.query(
        `INSERT INTO ${this.#t('branches')} (id, chatId, name, headMessageId, isActive, createdAt)
         VALUES ($1, $2, 'main', NULL, TRUE, $3)
         ON CONFLICT(chatId, name) DO NOTHING`,
        [crypto.randomUUID(), chat.id, Date.now()],
      );

      return upserted;
    });
  }

  async getChat(chatId: string): Promise<StoredChatData | undefined> {
    const [chat] = await this.#rows(
      storedChat,
      `SELECT * FROM ${this.#t('chats')} WHERE id = $1`,
      [chatId],
    );
    return chat;
  }

  async updateChat(
    chatId: string,
    update: ChatUpdater,
  ): Promise<StoredChatData> {
    return this.#useTransaction(async (client) => {
      const result = await client.query(
        `SELECT * FROM ${this.#t('chats')} WHERE id = $1 FOR UPDATE`,
        [chatId],
      );
      const current = storedChat.optional().parse(result.rows[0]);
      if (!current) {
        throw new Error(`updateChat: chat "${chatId}" not found`);
      }

      const updates = update(current);
      if (updates === undefined) return current;

      const setClauses = [
        'updatedAt = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT',
      ];
      const params: unknown[] = [];
      let paramIndex = 1;
      if (updates.title !== undefined) {
        setClauses.push(`title = $${paramIndex++}`);
        params.push(updates.title);
      }
      if (updates.metadata !== undefined) {
        setClauses.push(`metadata = $${paramIndex++}`);
        params.push(JSON.stringify(updates.metadata));
      }
      params.push(chatId);

      const updated = await client.query(
        `UPDATE ${this.#t('chats')} SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        params,
      );
      return storedChat.parse(updated.rows[0]);
    });
  }

  async listChats(options?: ListChatsOptions): Promise<ChatInfo[]> {
    const params: unknown[] = [];
    const whereClauses: string[] = [];
    let paramIndex = 1;

    if (options?.userId) {
      whereClauses.push(`c.userId = $${paramIndex++}`);
      params.push(options.userId);
    }

    if (options?.metadata) {
      const keyParam = paramIndex++;
      const valueParam = paramIndex++;
      whereClauses.push(`c.metadata->$${keyParam} = $${valueParam}::jsonb`);
      params.push(options.metadata.key);
      params.push(JSON.stringify(options.metadata.value));
    }

    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    let limitClause = '';
    if (options?.limit !== undefined) {
      limitClause = ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
      if (options.offset !== undefined) {
        limitClause += ` OFFSET $${paramIndex++}`;
        params.push(options.offset);
      }
    }

    return this.#rows(
      chatInfo,
      `SELECT
        c.id,
        c.userId,
        c.title,
        c.metadata,
        c.createdAt,
        c.updatedAt,
        COUNT(DISTINCT m.id) as messageCount,
        COUNT(DISTINCT b.id) as branchCount
      FROM ${this.#t('chats')} c
      LEFT JOIN ${this.#t('messages')} m ON m.chatId = c.id
      LEFT JOIN ${this.#t('branches')} b ON b.chatId = c.id
      ${whereClause}
      GROUP BY c.id
      ORDER BY c.updatedAt DESC${limitClause}`,
      params,
    );
  }

  async deleteChat(
    chatId: string,
    options?: DeleteChatOptions,
  ): Promise<boolean> {
    return this.#useTransaction(async (client) => {
      let sql = `DELETE FROM ${this.#t('chats')} WHERE id = $1`;
      const params: unknown[] = [chatId];

      if (options?.userId !== undefined) {
        sql += ' AND userId = $2';
        params.push(options.userId);
      }

      const result = await client.query(sql, params);
      return (result.rowCount ?? 0) > 0;
    });
  }

  // ==========================================================================
  // Message Operations (Graph Nodes)
  // ==========================================================================

  async addMessage(message: MessageData): Promise<void> {
    if (message.parentId === message.id) {
      throw new Error(`Message ${message.id} cannot be its own parent`);
    }

    await this.#useTransaction(async (client) => {
      await client.query(
        `INSERT INTO ${this.#t('messages')} (id, chatId, parentId, name, type, data, createdAt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(id) DO UPDATE SET
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           data = EXCLUDED.data`,
        [
          message.id,
          message.chatId,
          message.parentId,
          message.name,
          message.type ?? null,
          JSON.stringify(message.data),
          message.createdAt,
        ],
      );

      const content =
        typeof message.data === 'string'
          ? message.data
          : JSON.stringify(message.data);

      await client.query(
        `INSERT INTO ${this.#t('messages_fts')} (messageId, chatId, name, content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(messageId) DO UPDATE SET
           chatId = EXCLUDED.chatId,
           name = EXCLUDED.name,
           content = EXCLUDED.content`,
        [message.id, message.chatId, message.name, content],
      );
    });
  }

  async setMessageParent(
    messageId: string,
    parentId: string | null,
  ): Promise<void> {
    if (parentId === messageId) {
      throw new Error(`Message ${messageId} cannot be its own parent`);
    }
    const rows = await this.#rows(
      idRow,
      `UPDATE ${this.#t('messages')} SET parentId = $1 WHERE id = $2 RETURNING id`,
      [parentId, messageId],
    );
    if (rows.length === 0) {
      throw new Error(`Message ${messageId} not found`);
    }
  }

  async getMessage(messageId: string): Promise<MessageData | undefined> {
    const [message] = await this.#rows(
      storedMessage,
      `SELECT * FROM ${this.#t('messages')} WHERE id = $1`,
      [messageId],
    );
    return message;
  }

  async getMessageChain(headId: string): Promise<MessageData[]> {
    return this.#rows(
      storedMessage,
      `WITH RECURSIVE chain AS (
        SELECT *, 0 as depth FROM ${this.#t('messages')} WHERE id = $1
        UNION ALL
        SELECT m.*, c.depth + 1 FROM ${this.#t('messages')} m
        INNER JOIN chain c ON m.id = c.parentId
        WHERE c.depth < 10000
      )
      SELECT * FROM chain
      ORDER BY depth DESC`,
      [headId],
    );
  }

  async hasChildren(messageId: string): Promise<boolean> {
    const [row] = await this.#rows(
      existsRow,
      `SELECT EXISTS(SELECT 1 FROM ${this.#t('messages')} WHERE parentId = $1) as exists`,
      [messageId],
    );
    return row.exists;
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
    await this.#query(
      `INSERT INTO ${this.#t('branches')} (id, chatId, name, headMessageId, isActive, createdAt)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        branch.id,
        branch.chatId,
        branch.name,
        branch.headMessageId,
        branch.isActive,
        branch.createdAt,
      ],
    );
  }

  async getBranch(
    chatId: string,
    name: string,
  ): Promise<BranchData | undefined> {
    const [branch] = await this.#rows(
      storedBranch,
      `SELECT * FROM ${this.#t('branches')} WHERE chatId = $1 AND name = $2`,
      [chatId, name],
    );
    return branch;
  }

  async getActiveBranch(chatId: string): Promise<BranchData | undefined> {
    const [branch] = await this.#rows(
      storedBranch,
      `SELECT * FROM ${this.#t('branches')} WHERE chatId = $1 AND isActive = TRUE`,
      [chatId],
    );
    return branch;
  }

  async setActiveBranch(chatId: string, branchId: string): Promise<void> {
    await this.#useTransaction(async (client) => {
      await client.query(
        `UPDATE ${this.#t('branches')} SET isActive = FALSE WHERE chatId = $1`,
        [chatId],
      );

      await client.query(
        `UPDATE ${this.#t('branches')} SET isActive = TRUE WHERE id = $1`,
        [branchId],
      );
    });
  }

  async updateBranchHead(
    branchId: string,
    messageId: string | null,
    expectedHeadMessageId: string | null,
  ): Promise<boolean> {
    const rows = await this.#rows(
      idRow,
      `UPDATE ${this.#t('branches')} SET headMessageId = $1
       WHERE id = $2 AND headMessageId IS NOT DISTINCT FROM $3
       RETURNING id`,
      [messageId, branchId, expectedHeadMessageId],
    );
    return rows.length > 0;
  }

  async listBranches(chatId: string): Promise<BranchInfo[]> {
    const branches = await this.#rows(
      branchRow,
      `SELECT
        id,
        name,
        headMessageId,
        isActive,
        createdAt
      FROM ${this.#t('branches')}
      WHERE chatId = $1
      ORDER BY createdAt ASC`,
      [chatId],
    );

    const result: BranchInfo[] = [];
    for (const branch of branches) {
      result.push({
        id: branch.id,
        name: branch.name,
        headMessageId: branch.headmessageid,
        isActive: branch.isactive,
        messageCount: branch.headmessageid
          ? await this.#countChain(branch.headmessageid)
          : 0,
        createdAt: branch.createdat,
      });
    }

    return result;
  }

  async #countChain(headMessageId: string): Promise<number> {
    const [row] = await this.#rows(
      countRow,
      `WITH RECURSIVE chain AS (
        SELECT id, parentId FROM ${this.#t('messages')} WHERE id = $1
        UNION ALL
        SELECT m.id, m.parentId FROM ${this.#t('messages')} m
        INNER JOIN chain c ON m.id = c.parentId
      )
      SELECT COUNT(*) as count FROM chain`,
      [headMessageId],
    );
    return row.count;
  }

  // ==========================================================================
  // Checkpoint Operations
  // ==========================================================================

  async createCheckpoint(checkpoint: CheckpointData): Promise<void> {
    await this.#query(
      `INSERT INTO ${this.#t('checkpoints')} (id, chatId, name, messageId, createdAt)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(chatId, name) DO UPDATE SET
         messageId = EXCLUDED.messageId,
         createdAt = EXCLUDED.createdAt`,
      [
        checkpoint.id,
        checkpoint.chatId,
        checkpoint.name,
        checkpoint.messageId,
        checkpoint.createdAt,
      ],
    );
  }

  async getCheckpoint(
    chatId: string,
    name: string,
  ): Promise<CheckpointData | undefined> {
    const [checkpoint] = await this.#rows(
      storedCheckpoint,
      `SELECT * FROM ${this.#t('checkpoints')} WHERE chatId = $1 AND name = $2`,
      [chatId, name],
    );
    return checkpoint;
  }

  async listCheckpoints(chatId: string): Promise<CheckpointInfo[]> {
    return this.#rows(
      checkpointInfo,
      `SELECT id, name, messageId, createdAt
       FROM ${this.#t('checkpoints')}
       WHERE chatId = $1
       ORDER BY createdAt DESC`,
      [chatId],
    );
  }

  async deleteCheckpoint(chatId: string, name: string): Promise<void> {
    await this.#query(
      `DELETE FROM ${this.#t('checkpoints')} WHERE chatId = $1 AND name = $2`,
      [chatId, name],
    );
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

    let sql = `
      SELECT
        m.id,
        m.chatId,
        m.parentId,
        m.name,
        m.type,
        m.data,
        m.createdAt,
        ts_rank(fts.content_vector, plainto_tsquery('english', $2)) as rank,
        ts_headline('english', fts.content, plainto_tsquery('english', $2),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=32, MinWords=5, MaxFragments=1') as snippet
      FROM ${this.#t('messages_fts')} fts
      JOIN ${this.#t('messages')} m ON m.id = fts.messageId
      WHERE fts.content_vector @@ plainto_tsquery('english', $2)
        AND fts.chatId = $1
    `;

    const params: unknown[] = [chatId, query];
    let paramIndex = 3;

    if (roles && roles.length > 0) {
      const placeholders = roles.map(() => `$${paramIndex++}`).join(', ');
      sql += ` AND fts.name IN (${placeholders})`;
      params.push(...roles);
    }

    sql += ` ORDER BY rank DESC LIMIT $${paramIndex}`;
    params.push(limit);

    return this.#rows(searchResult, sql, params);
  }

  // ==========================================================================
  // Visualization Operations
  // ==========================================================================

  async getGraph(chatId: string): Promise<GraphData> {
    const messageRows = await this.#rows(
      graphMessageRow,
      `SELECT id, parentId, name, data, createdAt
       FROM ${this.#t('messages')}
       WHERE chatId = $1
       ORDER BY createdAt ASC`,
      [chatId],
    );

    const nodes: GraphNode[] = messageRows.map((row) => {
      const data = row.data;
      const content = typeof data === 'string' ? data : JSON.stringify(data);
      return {
        id: row.id,
        parentId: row.parentid,
        role: row.name,
        content: content.length > 50 ? content.slice(0, 50) + '...' : content,
        createdAt: row.createdat,
      };
    });

    const branches = await this.#rows(
      graphBranch,
      `SELECT name, headMessageId, isActive
       FROM ${this.#t('branches')}
       WHERE chatId = $1
       ORDER BY createdAt ASC`,
      [chatId],
    );

    const checkpoints = await this.#rows(
      graphCheckpoint,
      `SELECT name, messageId
       FROM ${this.#t('checkpoints')}
       WHERE chatId = $1
       ORDER BY createdAt ASC`,
      [chatId],
    );

    return {
      chatId,
      nodes,
      branches,
      checkpoints,
    };
  }
}
