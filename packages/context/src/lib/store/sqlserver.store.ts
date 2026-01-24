import type { ConnectionPool, Transaction, config } from 'mssql';
import { createRequire } from 'node:module';

import STORE_DDL from './ddl.sqlserver.sql';
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

export interface SqlServerStoreOptions {
  /**
   * SQL Server connection pool configuration.
   * Can be a connection string or config object.
   */
  pool: config | string;
}

/**
 * SQL Server-based context store using graph model.
 *
 * Uses mssql ConnectionPool for connection management.
 * Messages are stored as nodes in a DAG with parentId links.
 *
 * Requires `mssql` package to be installed:
 * ```
 * npm install mssql
 * ```
 */
export class SqlServerContextStore extends ContextStore {
  #pool: ConnectionPool;
  #initialized: Promise<void>;

  constructor(options: SqlServerStoreOptions) {
    super();
    // Dynamic import to support optional peer dependency
    const mssql = SqlServerContextStore.#requireMssql();
    this.#pool =
      typeof options.pool === 'string'
        ? new mssql.ConnectionPool(options.pool)
        : new mssql.ConnectionPool(options.pool);

    this.#initialized = this.#initialize();
  }

  static #requireMssql(): typeof import('mssql') {
    try {
      const require = createRequire(import.meta.url);
      return require('mssql');
    } catch {
      throw new Error(
        'SqlServerContextStore requires the "mssql" package. Install it with: npm install mssql',
      );
    }
  }

  async #initialize(): Promise<void> {
    await this.#pool.connect();
    // Run DDL - split by GO statements and execute each batch
    const batches = STORE_DDL.split(/\bGO\b/i).filter((b) => b.trim());
    for (const batch of batches) {
      if (batch.trim()) {
        await this.#pool.request().batch(batch);
      }
    }
  }

  /**
   * Ensure initialization is complete before any operation.
   */
  async #ensureInitialized(): Promise<void> {
    await this.#initialized;
  }

  /**
   * Execute a function within a transaction.
   * Automatically commits on success or rolls back on error.
   */
  async #useTransaction<T>(
    fn: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    await this.#ensureInitialized();
    const mssql = SqlServerContextStore.#requireMssql();
    const transaction = new mssql.Transaction(this.#pool);
    try {
      await transaction.begin();
      const result = await fn(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  /**
   * Execute a query using the pool (no transaction).
   * Converts positional params to SQL Server named params (@p0, @p1, ...).
   */
  async #query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    await this.#ensureInitialized();
    const request = this.#pool.request();

    // Add parameters: @p0, @p1, @p2...
    params?.forEach((value, index) => {
      request.input(`p${index}`, value);
    });

    const result = await request.query(sql);
    return result.recordset as T[];
  }

  /**
   * Close the pool connection.
   * Call this when done with the store.
   */
  async close(): Promise<void> {
    await this.#pool.close();
  }

  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  async createChat(chat: ChatData): Promise<StoredChatData> {
    return this.#useTransaction(async (transaction) => {
      const mssql = SqlServerContextStore.#requireMssql();

      // Create chat (createdAt and updatedAt are auto-set by SQL Server DEFAULT)
      const request = transaction.request();
      request.input('p0', mssql.NVarChar, chat.id);
      request.input('p1', mssql.NVarChar, chat.userId);
      request.input('p2', mssql.NVarChar, chat.title ?? null);
      request.input(
        'p3',
        mssql.NVarChar,
        chat.metadata ? JSON.stringify(chat.metadata) : null,
      );

      const result = await request.query(`
        INSERT INTO chats (id, userId, title, metadata)
        OUTPUT INSERTED.*
        VALUES (@p0, @p1, @p2, @p3)
      `);

      const row = result.recordset[0] as {
        id: string;
        userId: string;
        title: string | null;
        metadata: string | null;
        createdAt: number | string;
        updatedAt: number | string;
      };

      // Create "main" branch
      const branchRequest = transaction.request();
      branchRequest.input('p0', mssql.NVarChar, crypto.randomUUID());
      branchRequest.input('p1', mssql.NVarChar, chat.id);
      branchRequest.input('p2', mssql.BigInt, Date.now());

      await branchRequest.query(`
        INSERT INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
        VALUES (@p0, @p1, 'main', NULL, 1, @p2)
      `);

      return {
        id: row.id,
        userId: row.userId,
        title: row.title ?? undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      };
    });
  }

  async upsertChat(chat: ChatData): Promise<StoredChatData> {
    return this.#useTransaction(async (transaction) => {
      const mssql = SqlServerContextStore.#requireMssql();

      // Use MERGE for upsert
      const request = transaction.request();
      request.input('p0', mssql.NVarChar, chat.id);
      request.input('p1', mssql.NVarChar, chat.userId);
      request.input('p2', mssql.NVarChar, chat.title ?? null);
      request.input(
        'p3',
        mssql.NVarChar,
        chat.metadata ? JSON.stringify(chat.metadata) : null,
      );
      request.input('p4', mssql.BigInt, BigInt(Date.now()));

      // MERGE with both MATCHED (no-op update) and NOT MATCHED cases
      // The no-op update triggers OUTPUT for existing rows (same pattern as PostgreSQL's ON CONFLICT)
      const result = await request.query(`
        MERGE chats AS target
        USING (SELECT @p0 AS id, @p1 AS userId, @p2 AS title, @p3 AS metadata) AS source
        ON target.id = source.id
        WHEN MATCHED THEN
          UPDATE SET id = target.id
        WHEN NOT MATCHED THEN
          INSERT (id, userId, title, metadata, createdAt, updatedAt)
          VALUES (source.id, source.userId, source.title, source.metadata, @p4, @p4)
        OUTPUT INSERTED.*;
      `);

      const row = result.recordset[0] as {
        id: string;
        userId: string;
        title: string | null;
        metadata: string | null;
        createdAt: number | string;
        updatedAt: number | string;
      };

      // Ensure "main" branch exists
      const branchRequest = transaction.request();
      branchRequest.input('p0', mssql.NVarChar, crypto.randomUUID());
      branchRequest.input('p1', mssql.NVarChar, chat.id);
      branchRequest.input('p2', mssql.BigInt, Date.now());

      // Check if branch exists, insert if not
      await branchRequest.query(`
        IF NOT EXISTS (SELECT 1 FROM branches WHERE chatId = @p1 AND name = 'main')
        BEGIN
          INSERT INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
          VALUES (@p0, @p1, 'main', NULL, 1, @p2)
        END
      `);

      return {
        id: row.id,
        userId: row.userId,
        title: row.title ?? undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
      };
    });
  }

  async getChat(chatId: string): Promise<StoredChatData | undefined> {
    const rows = await this.#query<{
      id: string;
      userId: string;
      title: string | null;
      metadata: string | null;
      createdAt: number | string;
      updatedAt: number | string;
    }>('SELECT * FROM chats WHERE id = @p0', [chatId]);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      id: row.id,
      userId: row.userId,
      title: row.title ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  async updateChat(
    chatId: string,
    updates: Partial<Pick<ChatData, 'title' | 'metadata'>>,
  ): Promise<StoredChatData> {
    const setClauses: string[] = [
      "updatedAt = DATEDIFF_BIG(ms, '1970-01-01', GETUTCDATE())",
    ];
    const params: unknown[] = [];
    let paramIndex = 0;

    if (updates.title !== undefined) {
      setClauses.push(`title = @p${paramIndex++}`);
      params.push(updates.title ?? null);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = @p${paramIndex++}`);
      params.push(JSON.stringify(updates.metadata));
    }

    params.push(chatId);
    const rows = await this.#query<{
      id: string;
      userId: string;
      title: string | null;
      metadata: string | null;
      createdAt: number | string;
      updatedAt: number | string;
    }>(
      `UPDATE chats SET ${setClauses.join(', ')} OUTPUT INSERTED.* WHERE id = @p${paramIndex}`,
      params,
    );

    const row = rows[0];
    return {
      id: row.id,
      userId: row.userId,
      title: row.title ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  async listChats(options?: ListChatsOptions): Promise<ChatInfo[]> {
    const params: unknown[] = [];
    const whereClauses: string[] = [];
    let paramIndex = 0;

    // Build WHERE clause for userId filter
    if (options?.userId) {
      whereClauses.push(`c.userId = @p${paramIndex++}`);
      params.push(options.userId);
    }

    // Build WHERE clause for metadata filter (exact match on top-level field)
    // Use JSON_VALUE for NVARCHAR(MAX) JSON comparison
    if (options?.metadata) {
      whereClauses.push(
        `JSON_VALUE(c.metadata, '$.' + @p${paramIndex}) = @p${paramIndex + 1}`,
      );
      params.push(options.metadata.key);
      params.push(String(options.metadata.value));
      paramIndex += 2;
    }

    const whereClause =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Build pagination clause
    let paginationClause = '';
    if (options?.limit !== undefined) {
      paginationClause = ` OFFSET @p${paramIndex} ROWS FETCH NEXT @p${paramIndex + 1} ROWS ONLY`;
      params.push(options.offset ?? 0);
      params.push(options.limit);
    }

    const rows = await this.#query<{
      id: string;
      userId: string;
      title: string | null;
      metadata: string | null;
      createdAt: number | string;
      updatedAt: number | string;
      messageCount: number | string;
      branchCount: number | string;
    }>(
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
      GROUP BY c.id, c.userId, c.title, c.metadata, c.createdAt, c.updatedAt
      ORDER BY c.updatedAt DESC${paginationClause}`,
      params,
    );

    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      title: row.title ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      messageCount: Number(row.messageCount),
      branchCount: Number(row.branchCount),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    }));
  }

  async deleteChat(
    chatId: string,
    options?: DeleteChatOptions,
  ): Promise<boolean> {
    return this.#useTransaction(async (transaction) => {
      const mssql = SqlServerContextStore.#requireMssql();

      // Build the delete query with optional userId check
      const request = transaction.request();
      request.input('p0', mssql.NVarChar, chatId);

      let sql = 'DELETE FROM chats WHERE id = @p0';
      if (options?.userId !== undefined) {
        request.input('p1', mssql.NVarChar, options.userId);
        sql += ' AND userId = @p1';
      }

      // CASCADE handles messages, branches, checkpoints, and messages_fts
      const result = await request.query(sql);
      return (result.rowsAffected[0] ?? 0) > 0;
    });
  }

  // ==========================================================================
  // Message Operations (Graph Nodes)
  // ==========================================================================

  async addMessage(message: MessageData): Promise<void> {
    // Prevent circular reference - a message cannot be its own parent
    if (message.parentId === message.id) {
      throw new Error(`Message ${message.id} cannot be its own parent`);
    }

    await this.#useTransaction(async (transaction) => {
      const mssql = SqlServerContextStore.#requireMssql();

      // Upsert message using MERGE
      const request = transaction.request();
      request.input('p0', mssql.NVarChar, message.id);
      request.input('p1', mssql.NVarChar, message.chatId);
      request.input('p2', mssql.NVarChar, message.parentId);
      request.input('p3', mssql.NVarChar, message.name);
      request.input('p4', mssql.NVarChar, message.type ?? null);
      request.input('p5', mssql.NVarChar, JSON.stringify(message.data));
      request.input('p6', mssql.BigInt, message.createdAt);

      await request.query(`
        MERGE messages AS target
        USING (SELECT @p0 AS id) AS source
        ON target.id = source.id
        WHEN MATCHED THEN
          UPDATE SET name = @p3, type = @p4, data = @p5
        WHEN NOT MATCHED THEN
          INSERT (id, chatId, parentId, name, type, data, createdAt)
          VALUES (@p0, @p1, @p2, @p3, @p4, @p5, @p6);
      `);

      // Index in FTS for search
      const content =
        typeof message.data === 'string'
          ? message.data
          : JSON.stringify(message.data);

      // Upsert FTS entry
      const ftsRequest = transaction.request();
      ftsRequest.input('p0', mssql.NVarChar, message.id);
      ftsRequest.input('p1', mssql.NVarChar, message.chatId);
      ftsRequest.input('p2', mssql.NVarChar, message.name);
      ftsRequest.input('p3', mssql.NVarChar, content);

      await ftsRequest.query(`
        MERGE messages_fts AS target
        USING (SELECT @p0 AS messageId) AS source
        ON target.messageId = source.messageId
        WHEN MATCHED THEN
          UPDATE SET chatId = @p1, name = @p2, content = @p3
        WHEN NOT MATCHED THEN
          INSERT (messageId, chatId, name, content)
          VALUES (@p0, @p1, @p2, @p3);
      `);
    });
  }

  async getMessage(messageId: string): Promise<MessageData | undefined> {
    const rows = await this.#query<{
      id: string;
      chatId: string;
      parentId: string | null;
      name: string;
      type: string | null;
      data: string;
      createdAt: number | string;
    }>('SELECT * FROM messages WHERE id = @p0', [messageId]);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      id: row.id,
      chatId: row.chatId,
      parentId: row.parentId,
      name: row.name,
      type: row.type ?? undefined,
      data: JSON.parse(row.data),
      createdAt: Number(row.createdAt),
    };
  }

  async getMessageChain(headId: string): Promise<MessageData[]> {
    // Walk up the parent chain using recursive CTE with depth tracking
    // The CTE walks from head (newest) to root (oldest), so we track depth
    // and order by depth DESC to get chronological order (root first)
    // Depth limit of 10000 prevents infinite loops from circular references
    const rows = await this.#query<{
      id: string;
      chatId: string;
      parentId: string | null;
      name: string;
      type: string | null;
      data: string;
      createdAt: number | string;
      depth: number;
    }>(
      `WITH chain AS (
        SELECT *, 0 as depth FROM messages WHERE id = @p0
        UNION ALL
        SELECT m.*, c.depth + 1 FROM messages m
        INNER JOIN chain c ON m.id = c.parentId
        WHERE c.depth < 10000
      )
      SELECT * FROM chain
      ORDER BY depth DESC`,
      [headId],
    );

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      parentId: row.parentId,
      name: row.name,
      type: row.type ?? undefined,
      data: JSON.parse(row.data),
      createdAt: Number(row.createdAt),
    }));
  }

  async hasChildren(messageId: string): Promise<boolean> {
    const rows = await this.#query<{ hasChildren: number }>(
      `SELECT CASE WHEN EXISTS(SELECT 1 FROM messages WHERE parentId = @p0) THEN 1 ELSE 0 END as hasChildren`,
      [messageId],
    );
    return rows[0].hasChildren === 1;
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
      `INSERT INTO branches (id, chatId, name, headMessageId, isActive, createdAt)
       VALUES (@p0, @p1, @p2, @p3, @p4, @p5)`,
      [
        branch.id,
        branch.chatId,
        branch.name,
        branch.headMessageId,
        branch.isActive ? 1 : 0,
        branch.createdAt,
      ],
    );
  }

  async getBranch(
    chatId: string,
    name: string,
  ): Promise<BranchData | undefined> {
    const rows = await this.#query<{
      id: string;
      chatId: string;
      name: string;
      headMessageId: string | null;
      isActive: boolean | number;
      createdAt: number | string;
    }>('SELECT * FROM branches WHERE chatId = @p0 AND name = @p1', [
      chatId,
      name,
    ]);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      id: row.id,
      chatId: row.chatId,
      name: row.name,
      headMessageId: row.headMessageId,
      isActive: row.isActive === true || row.isActive === 1,
      createdAt: Number(row.createdAt),
    };
  }

  async getActiveBranch(chatId: string): Promise<BranchData | undefined> {
    const rows = await this.#query<{
      id: string;
      chatId: string;
      name: string;
      headMessageId: string | null;
      isActive: boolean | number;
      createdAt: number | string;
    }>('SELECT * FROM branches WHERE chatId = @p0 AND isActive = 1', [chatId]);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      id: row.id,
      chatId: row.chatId,
      name: row.name,
      headMessageId: row.headMessageId,
      isActive: true,
      createdAt: Number(row.createdAt),
    };
  }

  async setActiveBranch(chatId: string, branchId: string): Promise<void> {
    await this.#useTransaction(async (transaction) => {
      const mssql = SqlServerContextStore.#requireMssql();

      // Deactivate all branches for this chat
      const deactivateRequest = transaction.request();
      deactivateRequest.input('p0', mssql.NVarChar, chatId);
      await deactivateRequest.query(
        'UPDATE branches SET isActive = 0 WHERE chatId = @p0',
      );

      // Activate the specified branch
      const activateRequest = transaction.request();
      activateRequest.input('p0', mssql.NVarChar, branchId);
      await activateRequest.query(
        'UPDATE branches SET isActive = 1 WHERE id = @p0',
      );
    });
  }

  async updateBranchHead(
    branchId: string,
    messageId: string | null,
  ): Promise<void> {
    await this.#query(
      'UPDATE branches SET headMessageId = @p0 WHERE id = @p1',
      [messageId, branchId],
    );
  }

  async listBranches(chatId: string): Promise<BranchInfo[]> {
    // Get branches with message count by walking the chain
    const branches = await this.#query<{
      id: string;
      name: string;
      headMessageId: string | null;
      isActive: boolean | number;
      createdAt: number | string;
    }>(
      `SELECT
        id,
        name,
        headMessageId,
        isActive,
        createdAt
      FROM branches
      WHERE chatId = @p0
      ORDER BY createdAt ASC`,
      [chatId],
    );

    // For each branch, count messages in the chain
    const result: BranchInfo[] = [];
    for (const branch of branches) {
      let messageCount = 0;
      if (branch.headMessageId) {
        const countRows = await this.#query<{ count: number | string }>(
          `WITH chain AS (
            SELECT id, parentId FROM messages WHERE id = @p0
            UNION ALL
            SELECT m.id, m.parentId FROM messages m
            INNER JOIN chain c ON m.id = c.parentId
          )
          SELECT COUNT(*) as count FROM chain`,
          [branch.headMessageId],
        );
        messageCount = Number(countRows[0].count);
      }

      result.push({
        id: branch.id,
        name: branch.name,
        headMessageId: branch.headMessageId,
        isActive: branch.isActive === true || branch.isActive === 1,
        messageCount,
        createdAt: Number(branch.createdAt),
      });
    }

    return result;
  }

  // ==========================================================================
  // Checkpoint Operations
  // ==========================================================================

  async createCheckpoint(checkpoint: CheckpointData): Promise<void> {
    await this.#useTransaction(async (transaction) => {
      const mssql = SqlServerContextStore.#requireMssql();

      const request = transaction.request();
      request.input('p0', mssql.NVarChar, checkpoint.id);
      request.input('p1', mssql.NVarChar, checkpoint.chatId);
      request.input('p2', mssql.NVarChar, checkpoint.name);
      request.input('p3', mssql.NVarChar, checkpoint.messageId);
      request.input('p4', mssql.BigInt, checkpoint.createdAt);

      // Upsert using MERGE
      await request.query(`
        MERGE checkpoints AS target
        USING (SELECT @p1 AS chatId, @p2 AS name) AS source
        ON target.chatId = source.chatId AND target.name = source.name
        WHEN MATCHED THEN
          UPDATE SET messageId = @p3, createdAt = @p4
        WHEN NOT MATCHED THEN
          INSERT (id, chatId, name, messageId, createdAt)
          VALUES (@p0, @p1, @p2, @p3, @p4);
      `);
    });
  }

  async getCheckpoint(
    chatId: string,
    name: string,
  ): Promise<CheckpointData | undefined> {
    const rows = await this.#query<{
      id: string;
      chatId: string;
      name: string;
      messageId: string;
      createdAt: number | string;
    }>('SELECT * FROM checkpoints WHERE chatId = @p0 AND name = @p1', [
      chatId,
      name,
    ]);

    if (rows.length === 0) {
      return undefined;
    }

    const row = rows[0];
    return {
      id: row.id,
      chatId: row.chatId,
      name: row.name,
      messageId: row.messageId,
      createdAt: Number(row.createdAt),
    };
  }

  async listCheckpoints(chatId: string): Promise<CheckpointInfo[]> {
    const rows = await this.#query<{
      id: string;
      name: string;
      messageId: string;
      createdAt: number | string;
    }>(
      `SELECT id, name, messageId, createdAt
       FROM checkpoints
       WHERE chatId = @p0
       ORDER BY createdAt DESC`,
      [chatId],
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      messageId: row.messageId,
      createdAt: Number(row.createdAt),
    }));
  }

  async deleteCheckpoint(chatId: string, name: string): Promise<void> {
    await this.#query(
      'DELETE FROM checkpoints WHERE chatId = @p0 AND name = @p1',
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

    // Check if FTS is available - if not, fall back to LIKE search
    const ftsCheck = await this.#query<{ ftsInstalled: number }>(
      `SELECT CAST(SERVERPROPERTY('IsFullTextInstalled') AS INT) as ftsInstalled`,
    );
    const ftsAvailable = ftsCheck[0]?.ftsInstalled === 1;

    if (ftsAvailable) {
      // Use CONTAINSTABLE for full-text search
      // Note: SQL Server FTS doesn't have ts_headline, so we use SUBSTRING for snippet
      let sql = `
        SELECT
          m.id,
          m.chatId,
          m.parentId,
          m.name,
          m.type,
          m.data,
          m.createdAt,
          ct.RANK as rank,
          SUBSTRING(fts.content, 1, 200) as snippet
        FROM messages_fts fts
        INNER JOIN CONTAINSTABLE(messages_fts, content, @p0) ct
          ON fts.messageId = ct.[KEY]
        INNER JOIN messages m ON m.id = fts.messageId
        WHERE fts.chatId = @p1
      `;

      const params: unknown[] = [query, chatId];
      let paramIndex = 2;

      if (roles && roles.length > 0) {
        const placeholders = roles.map(() => `@p${paramIndex++}`).join(', ');
        sql += ` AND fts.name IN (${placeholders})`;
        params.push(...roles);
      }

      sql += ` ORDER BY ct.RANK DESC OFFSET 0 ROWS FETCH NEXT @p${paramIndex} ROWS ONLY`;
      params.push(limit);

      const rows = await this.#query<{
        id: string;
        chatId: string;
        parentId: string | null;
        name: string;
        type: string | null;
        data: string;
        createdAt: number | string;
        rank: number;
        snippet: string;
      }>(sql, params);

      return rows.map((row) => ({
        message: {
          id: row.id,
          chatId: row.chatId,
          parentId: row.parentId,
          name: row.name,
          type: row.type ?? undefined,
          data: JSON.parse(row.data),
          createdAt: Number(row.createdAt),
        },
        rank: row.rank,
        snippet: row.snippet,
      }));
    } else {
      // Fallback to LIKE search when FTS is not installed
      let sql = `
        SELECT
          m.id,
          m.chatId,
          m.parentId,
          m.name,
          m.type,
          m.data,
          m.createdAt,
          1 as rank,
          SUBSTRING(fts.content, 1, 200) as snippet
        FROM messages_fts fts
        INNER JOIN messages m ON m.id = fts.messageId
        WHERE fts.chatId = @p0 AND fts.content LIKE '%' + @p1 + '%'
      `;

      const params: unknown[] = [chatId, query];
      let paramIndex = 2;

      if (roles && roles.length > 0) {
        const placeholders = roles.map(() => `@p${paramIndex++}`).join(', ');
        sql += ` AND fts.name IN (${placeholders})`;
        params.push(...roles);
      }

      sql += ` ORDER BY m.createdAt DESC OFFSET 0 ROWS FETCH NEXT @p${paramIndex} ROWS ONLY`;
      params.push(limit);

      const rows = await this.#query<{
        id: string;
        chatId: string;
        parentId: string | null;
        name: string;
        type: string | null;
        data: string;
        createdAt: number | string;
        rank: number;
        snippet: string;
      }>(sql, params);

      return rows.map((row) => ({
        message: {
          id: row.id,
          chatId: row.chatId,
          parentId: row.parentId,
          name: row.name,
          type: row.type ?? undefined,
          data: JSON.parse(row.data),
          createdAt: Number(row.createdAt),
        },
        rank: row.rank,
        snippet: row.snippet,
      }));
    }
  }

  // ==========================================================================
  // Visualization Operations
  // ==========================================================================

  async getGraph(chatId: string): Promise<GraphData> {
    // Get all messages for complete graph
    const messageRows = await this.#query<{
      id: string;
      parentId: string | null;
      name: string;
      data: string;
      createdAt: number | string;
    }>(
      `SELECT id, parentId, name, data, createdAt
       FROM messages
       WHERE chatId = @p0
       ORDER BY createdAt ASC`,
      [chatId],
    );

    const nodes: GraphNode[] = messageRows.map((row) => {
      const data = JSON.parse(row.data);
      const content = typeof data === 'string' ? data : JSON.stringify(data);
      return {
        id: row.id,
        parentId: row.parentId,
        role: row.name,
        content: content.length > 50 ? content.slice(0, 50) + '...' : content,
        createdAt: Number(row.createdAt),
      };
    });

    // Get all branches
    const branchRows = await this.#query<{
      name: string;
      headMessageId: string | null;
      isActive: boolean | number;
    }>(
      `SELECT name, headMessageId, isActive
       FROM branches
       WHERE chatId = @p0
       ORDER BY createdAt ASC`,
      [chatId],
    );

    const branches: GraphBranch[] = branchRows.map((row) => ({
      name: row.name,
      headMessageId: row.headMessageId,
      isActive: row.isActive === true || row.isActive === 1,
    }));

    // Get all checkpoints
    const checkpointRows = await this.#query<{
      name: string;
      messageId: string;
    }>(
      `SELECT name, messageId
       FROM checkpoints
       WHERE chatId = @p0
       ORDER BY createdAt ASC`,
      [chatId],
    );

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
