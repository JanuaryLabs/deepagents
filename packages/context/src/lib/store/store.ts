/**
 * Graph-based context store types and abstract interface.
 *
 * The storage model uses a DAG (Directed Acyclic Graph) for messages:
 * - Messages are immutable nodes with parentId forming the graph
 * - Branches are pointers to head (tip) messages
 * - Checkpoints are pointers to specific messages
 * - History is preserved through branching (rewind creates new branch)
 */

// ============================================================================
// Chat Types
// ============================================================================

/**
 * Data for creating/storing a chat.
 */
export interface ChatData {
  id: string;
  title?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Information about a chat for listing.
 */
export interface ChatInfo {
  id: string;
  title?: string;
  messageCount: number;
  branchCount: number;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Message Types (Graph Nodes)
// ============================================================================

/**
 * Data for creating/storing a message (graph node).
 */
export interface MessageData {
  id: string;
  chatId: string;
  parentId: string | null; // null for root messages
  name: string; // 'user', 'assistant', 'role', 'hint', etc.
  type?: string; // 'message', 'fragment'
  data: unknown; // JSON-serializable content
  persist: boolean;
  createdAt: number;
}

/**
 * Message with computed properties for listing.
 */
export interface MessageInfo extends MessageData {
  hasChildren: boolean;
}

// ============================================================================
// Branch Types
// ============================================================================

/**
 * Data for creating/storing a branch.
 * A branch is a pointer to a head message in the graph.
 */
export interface BranchData {
  id: string;
  chatId: string;
  name: string; // 'main', 'alt-1', etc.
  headMessageId: string | null; // null if branch is empty
  isActive: boolean;
  createdAt: number;
}

/**
 * Information about a branch for listing.
 */
export interface BranchInfo {
  id: string;
  name: string;
  headMessageId: string | null;
  isActive: boolean;
  messageCount: number; // count of messages in this branch's chain
  createdAt: number;
}

// ============================================================================
// Checkpoint Types
// ============================================================================

/**
 * Data for creating/storing a checkpoint.
 * A checkpoint is a pointer to a specific message in the graph.
 */
export interface CheckpointData {
  id: string;
  chatId: string;
  name: string;
  messageId: string;
  createdAt: number;
}

/**
 * Information about a checkpoint for listing.
 */
export interface CheckpointInfo {
  id: string;
  name: string;
  messageId: string;
  createdAt: number;
}

// ============================================================================
// Search Types
// ============================================================================

/**
 * Options for searching messages.
 */
export interface SearchOptions {
  /** Only search in specific roles (e.g., ['user', 'assistant']) */
  roles?: string[];
  /** Maximum results to return (default: 20) */
  limit?: number;
}

/**
 * Search result with relevance ranking.
 */
export interface SearchResult {
  /** The matched message */
  message: MessageData;
  /** BM25 relevance score (lower = more relevant) */
  rank: number;
  /** Highlighted snippet with matched terms */
  snippet?: string;
}

// ============================================================================
// Graph Visualization Types
// ============================================================================

/**
 * A node in the visualization graph.
 */
export interface GraphNode {
  id: string;
  parentId: string | null;
  role: string; // 'user', 'assistant', etc.
  content: string; // Truncated preview of message content
  createdAt: number;
}

/**
 * A branch pointer for visualization.
 */
export interface GraphBranch {
  name: string;
  headMessageId: string | null;
  isActive: boolean;
}

/**
 * A checkpoint pointer for visualization.
 */
export interface GraphCheckpoint {
  name: string;
  messageId: string;
}

/**
 * Complete graph data for visualization.
 */
export interface GraphData {
  chatId: string;
  nodes: GraphNode[];
  branches: GraphBranch[];
  checkpoints: GraphCheckpoint[];
}

// ============================================================================
// Abstract Store Interface
// ============================================================================

/**
 * Abstract base class for graph-based context storage.
 *
 * Implementations provide persistence for the message graph, branches,
 * and checkpoints. The graph model enables:
 * - Branching: rewind creates a new branch, original stays intact
 * - Checkpoints: pointers to specific messages for easy restore
 * - No data loss: soft delete only, all history preserved
 */
export abstract class ContextStore {
  // ==========================================================================
  // Chat Operations
  // ==========================================================================

  /**
   * Create a new chat.
   */
  abstract createChat(chat: ChatData): Promise<void>;

  /**
   * Get a chat by ID.
   */
  abstract getChat(chatId: string): Promise<ChatData | undefined>;

  /**
   * Update chat metadata.
   */
  abstract updateChat(
    chatId: string,
    updates: Partial<Pick<ChatData, 'title' | 'metadata' | 'updatedAt'>>,
  ): Promise<void>;

  /**
   * List all chats, sorted by updatedAt descending.
   */
  abstract listChats(): Promise<ChatInfo[]>;

  // ==========================================================================
  // Message Operations (Graph Nodes)
  // ==========================================================================

  /**
   * Add a message to the graph.
   */
  abstract addMessage(message: MessageData): Promise<void>;

  /**
   * Get a message by ID.
   */
  abstract getMessage(messageId: string): Promise<MessageData | undefined>;

  /**
   * Walk up the parent chain from a head message, returning messages in
   * chronological order (root first).
   */
  abstract getMessageChain(headId: string): Promise<MessageData[]>;

  /**
   * Check if a message has children (is a fork point).
   */
  abstract hasChildren(messageId: string): Promise<boolean>;

  // ==========================================================================
  // Branch Operations
  // ==========================================================================

  /**
   * Create a new branch.
   */
  abstract createBranch(branch: BranchData): Promise<void>;

  /**
   * Get a branch by chat ID and name.
   */
  abstract getBranch(
    chatId: string,
    name: string,
  ): Promise<BranchData | undefined>;

  /**
   * Get the active branch for a chat.
   */
  abstract getActiveBranch(chatId: string): Promise<BranchData | undefined>;

  /**
   * Set a branch as active (and deactivate others).
   */
  abstract setActiveBranch(chatId: string, branchId: string): Promise<void>;

  /**
   * Update a branch's head message.
   */
  abstract updateBranchHead(
    branchId: string,
    messageId: string | null,
  ): Promise<void>;

  /**
   * List all branches for a chat.
   */
  abstract listBranches(chatId: string): Promise<BranchInfo[]>;

  // ==========================================================================
  // Checkpoint Operations
  // ==========================================================================

  /**
   * Create a checkpoint.
   */
  abstract createCheckpoint(checkpoint: CheckpointData): Promise<void>;

  /**
   * Get a checkpoint by chat ID and name.
   */
  abstract getCheckpoint(
    chatId: string,
    name: string,
  ): Promise<CheckpointData | undefined>;

  /**
   * List all checkpoints for a chat.
   */
  abstract listCheckpoints(chatId: string): Promise<CheckpointInfo[]>;

  /**
   * Delete a checkpoint.
   */
  abstract deleteCheckpoint(chatId: string, name: string): Promise<void>;

  // ==========================================================================
  // Search Operations
  // ==========================================================================

  /**
   * Search messages using full-text search.
   *
   * @param chatId - The chat to search in
   * @param query - FTS5 query string (supports AND, OR, NOT, phrases, prefix*)
   * @param options - Search options
   * @returns Search results ordered by relevance (lower rank = more relevant)
   */
  abstract searchMessages(
    chatId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]>;

  // ==========================================================================
  // Visualization Operations
  // ==========================================================================

  /**
   * Get the complete graph data for a chat.
   * Returns all messages, branches, and checkpoints.
   */
  abstract getGraph(chatId: string): Promise<GraphData>;
}
