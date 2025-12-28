import type { ContextFragment } from './lib/context.ts';
import { isMessageFragment } from './lib/context.ts';
import { type EstimateResult, getModelsRegistry } from './lib/estimate.ts';
import type { Models } from './lib/models.generated.ts';
import {
  type ContextRenderer,
  XmlRenderer,
} from './lib/renderers/abstract.renderer.ts';
import {
  type BranchData,
  type BranchInfo,
  type ChatData,
  type CheckpointData,
  type CheckpointInfo,
  ContextStore,
  type MessageData,
} from './lib/store/store.ts';

export type { ContextFragment, FragmentType } from './lib/context.ts';
export { isMessageFragment } from './lib/context.ts';
export {
  ContextStore,
  type ChatData,
  type ChatInfo,
  type MessageData,
  type MessageInfo,
  type BranchData,
  type BranchInfo,
  type CheckpointData,
  type CheckpointInfo,
} from './lib/store/store.ts';
export { SqliteContextStore } from './lib/store/sqlite.store.ts';
export { InMemoryContextStore } from './lib/store/memory.store.ts';

/**
 * Message format compatible with AI SDK's CoreMessage.
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Result of resolving context - ready for AI SDK consumption.
 */
export interface ResolveResult {
  /** Rendered non-message fragments for system prompt */
  systemPrompt: string;
  /** Message fragments decoded to AI SDK format */
  messages: Message[];
}

/**
 * Options for resolve().
 */
export interface ResolveOptions {
  /** Renderer to use for system prompt (defaults to XmlRenderer) */
  renderer?: ContextRenderer;
}

/**
 * Options for creating a ContextEngine.
 */
export interface ContextEngineOptions {
  /** Store for persisting fragments (required) */
  store: ContextStore;
  /** Unique identifier for this chat (required) */
  chatId: string;
  /** Branch name (defaults to 'main') */
  branch?: string;
}

/**
 * Options for creating message fragments.
 */
export interface MessageOptions {
  /** Custom ID for the fragment. If not provided, auto-generates UUID. */
  id?: string;
}

/**
 * Metadata about a chat.
 */
export interface ChatMeta {
  /** Unique chat identifier */
  id: string;
  /** When the chat was created */
  createdAt: number;
  /** When the chat was last updated */
  updatedAt: number;
  /** Optional user-provided title */
  title?: string;
  /** Optional custom metadata */
  metadata?: Record<string, unknown>;
}

export {
  type ContextRenderer,
  type RendererOptions,
  XmlRenderer,
  MarkdownRenderer,
  TomlRenderer,
  ToonRenderer,
} from './lib/renderers/abstract.renderer.ts';
export {
  type ModelCost,
  type ModelInfo,
  type EstimateResult,
  type Tokenizer,
  defaultTokenizer,
  ModelsRegistry,
  getModelsRegistry,
} from './lib/estimate.ts';
export type { Models, KnownModels } from './lib/models.generated.ts';

/**
 * Context engine for managing AI conversation context with graph-based storage.
 *
 * The engine uses a DAG (Directed Acyclic Graph) model for messages:
 * - Messages are nodes with parentId forming the graph
 * - Branches are pointers to head (tip) messages
 * - Checkpoints are pointers to specific messages
 * - No hard deletion - only soft delete via 'deleted' flag
 */
export class ContextEngine {
  /** Non-message fragments (role, hints, etc.) - not persisted in graph */
  #contextFragments: ContextFragment[] = [];
  /** Pending message fragments to be added to graph */
  #pendingMessages: ContextFragment[] = [];
  #store: ContextStore;
  #chatId: string;
  #branchName: string;
  #branch: BranchData | null = null;
  #chatData: ChatData | null = null;
  #initialized = false;

  constructor(options: ContextEngineOptions) {
    if (!options.chatId) {
      throw new Error('chatId is required');
    }
    this.#store = options.store;
    this.#chatId = options.chatId;
    this.#branchName = options.branch ?? 'main';
  }

  /**
   * Initialize the chat and branch if they don't exist.
   */
  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    // Get or create chat
    const existingChat = await this.#store.getChat(this.#chatId);
    if (existingChat) {
      this.#chatData = existingChat;
    } else {
      const now = Date.now();
      this.#chatData = {
        id: this.#chatId,
        createdAt: now,
        updatedAt: now,
      };
      await this.#store.createChat(this.#chatData);
    }

    // Get or create branch
    const existingBranch = await this.#store.getBranch(
      this.#chatId,
      this.#branchName,
    );
    if (existingBranch) {
      this.#branch = existingBranch;
    } else {
      this.#branch = {
        id: crypto.randomUUID(),
        chatId: this.#chatId,
        name: this.#branchName,
        headMessageId: null,
        isActive: true,
        createdAt: Date.now(),
      };
      await this.#store.createBranch(this.#branch);
    }

    this.#initialized = true;
  }

  /**
   * Get the current chat ID.
   */
  public get chatId(): string {
    return this.#chatId;
  }

  /**
   * Get the current branch name.
   */
  public get branch(): string {
    return this.#branchName;
  }

  /**
   * Get metadata for the current chat.
   * Returns null if the chat hasn't been initialized yet.
   */
  public get chat(): ChatMeta | null {
    if (!this.#chatData) {
      return null;
    }
    return {
      id: this.#chatData.id,
      createdAt: this.#chatData.createdAt,
      updatedAt: this.#chatData.updatedAt,
      title: this.#chatData.title,
      metadata: this.#chatData.metadata,
    };
  }

  /**
   * Add fragments to the context.
   *
   * - Message fragments (user/assistant) are queued for persistence
   * - Non-message fragments (role/hint) are kept in memory for system prompt
   */
  public set(...fragments: ContextFragment[]) {
    for (const fragment of fragments) {
      if (isMessageFragment(fragment)) {
        this.#pendingMessages.push(fragment);
      } else {
        this.#contextFragments.push(fragment);
      }
    }
    return this;
  }

  /**
   * Render all fragments using the provided renderer.
   * @internal Use resolve() instead for public API.
   */
  public render(renderer: ContextRenderer) {
    return renderer.render(this.#contextFragments);
  }

  /**
   * Resolve context into AI SDK-ready format.
   *
   * - Initializes chat and branch if needed
   * - Loads message history from the graph (walking parent chain)
   * - Separates context fragments for system prompt
   * - Combines with pending messages
   *
   * @example
   * ```ts
   * const context = new ContextEngine({ store, chatId: 'chat-1' })
   *   .set(role('You are helpful'), user('Hello'));
   *
   * const { systemPrompt, messages } = await context.resolve();
   * await generateText({ system: systemPrompt, messages });
   * ```
   */
  public async resolve(options: ResolveOptions = {}): Promise<ResolveResult> {
    await this.#ensureInitialized();

    const renderer = options.renderer ?? new XmlRenderer();

    // Render context fragments to system prompt
    const systemPrompt = renderer.render(this.#contextFragments);

    // Get persisted messages from graph
    const persistedMessages: MessageData[] = [];
    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      persistedMessages.push(...chain);
    }

    // Convert persisted messages to AI SDK format
    const messages: Message[] = persistedMessages.map((msg) => ({
      role: msg.name as Message['role'],
      content: String(msg.data),
    }));

    // Add pending messages (not yet saved)
    for (const fragment of this.#pendingMessages) {
      messages.push({
        role: fragment.name as Message['role'],
        content: String(fragment.data),
      });
    }

    return { systemPrompt, messages };
  }

  /**
   * Save pending messages to the graph.
   *
   * Each message is added as a node with parentId pointing to the previous message.
   * The branch head is updated to point to the last message.
   *
   * @example
   * ```ts
   * context.set(user('Hello'));
   * // AI responds...
   * context.set(assistant('Hi there!'));
   * await context.save(); // Persist to graph
   * ```
   */
  public async save(): Promise<void> {
    await this.#ensureInitialized();

    if (this.#pendingMessages.length === 0) {
      return;
    }

    let parentId = this.#branch!.headMessageId;
    const now = Date.now();

    // Add each pending message to the graph
    for (const fragment of this.#pendingMessages) {
      const messageData: MessageData = {
        id: fragment.id ?? crypto.randomUUID(),
        chatId: this.#chatId,
        parentId,
        name: fragment.name,
        type: fragment.type,
        data: fragment.data,
        persist: fragment.persist ?? true,
        deleted: false,
        createdAt: now,
      };

      await this.#store.addMessage(messageData);
      parentId = messageData.id;
    }

    // Update branch head to last message
    await this.#store.updateBranchHead(this.#branch!.id, parentId);
    this.#branch!.headMessageId = parentId;

    // Update chat timestamp
    await this.#store.updateChat(this.#chatId, { updatedAt: now });
    if (this.#chatData) {
      this.#chatData.updatedAt = now;
    }

    // Clear pending messages
    this.#pendingMessages = [];
  }

  /**
   * Estimate token count and cost for the current context.
   *
   * @param modelId - Model ID (e.g., "openai:gpt-4o", "anthropic:claude-3-5-sonnet")
   * @param options - Optional settings
   * @returns Estimate result with token counts and costs
   */
  public async estimate(
    modelId: Models,
    options: {
      renderer?: ContextRenderer;
    } = {},
  ): Promise<EstimateResult> {
    const renderer = options.renderer ?? new XmlRenderer();
    const renderedContext = this.render(renderer);

    const registry = getModelsRegistry();
    await registry.load();

    return registry.estimate(modelId, renderedContext);
  }

  /**
   * Rewind to a specific message by ID.
   *
   * Creates a new branch from that message, preserving the original branch.
   * The new branch becomes active.
   *
   * @param messageId - The message ID to rewind to
   * @returns The new branch info
   *
   * @example
   * ```ts
   * context.set(user('What is 2 + 2?', { id: 'q1' }));
   * context.set(assistant('The answer is 5.', { id: 'wrong' })); // Oops!
   * await context.save();
   *
   * // Rewind to the question, creates new branch
   * const newBranch = await context.rewind('q1');
   *
   * // Now add correct answer on new branch
   * context.set(assistant('The answer is 4.'));
   * await context.save();
   * ```
   */
  public async rewind(messageId: string): Promise<BranchInfo> {
    await this.#ensureInitialized();

    // Verify the message exists
    const message = await this.#store.getMessage(messageId);
    if (!message) {
      throw new Error(`Message "${messageId}" not found`);
    }
    if (message.chatId !== this.#chatId) {
      throw new Error(`Message "${messageId}" belongs to a different chat`);
    }

    // Count existing branches to generate name
    const branches = await this.#store.listBranches(this.#chatId);
    const newBranchName = `${this.#branchName}-v${branches.length + 1}`;

    // Create new branch pointing to the target message
    const newBranch: BranchData = {
      id: crypto.randomUUID(),
      chatId: this.#chatId,
      name: newBranchName,
      headMessageId: messageId,
      isActive: false,
      createdAt: Date.now(),
    };
    await this.#store.createBranch(newBranch);

    // Switch to new branch
    await this.#store.setActiveBranch(this.#chatId, newBranch.id);
    this.#branch = { ...newBranch, isActive: true };
    this.#branchName = newBranchName;

    // Clear pending messages (they were for the old branch)
    this.#pendingMessages = [];

    // Return branch info
    const chain = await this.#store.getMessageChain(messageId);
    return {
      id: newBranch.id,
      name: newBranch.name,
      headMessageId: newBranch.headMessageId,
      isActive: true,
      messageCount: chain.length,
      createdAt: newBranch.createdAt,
    };
  }

  /**
   * Create a checkpoint at the current position.
   *
   * A checkpoint is a named pointer to the current branch head.
   * Use restore() to return to this point later.
   *
   * @param name - Name for the checkpoint
   * @returns The checkpoint info
   *
   * @example
   * ```ts
   * context.set(user('I want to learn a new skill.'));
   * context.set(assistant('Would you like coding or cooking?'));
   * await context.save();
   *
   * // Save checkpoint before user's choice
   * const cp = await context.checkpoint('before-choice');
   * ```
   */
  public async checkpoint(name: string): Promise<CheckpointInfo> {
    await this.#ensureInitialized();

    if (!this.#branch?.headMessageId) {
      throw new Error('Cannot create checkpoint: no messages in conversation');
    }

    const checkpoint: CheckpointData = {
      id: crypto.randomUUID(),
      chatId: this.#chatId,
      name,
      messageId: this.#branch.headMessageId,
      createdAt: Date.now(),
    };

    await this.#store.createCheckpoint(checkpoint);

    return {
      id: checkpoint.id,
      name: checkpoint.name,
      messageId: checkpoint.messageId,
      createdAt: checkpoint.createdAt,
    };
  }

  /**
   * Restore to a checkpoint by creating a new branch from that point.
   *
   * @param name - Name of the checkpoint to restore
   * @returns The new branch info
   *
   * @example
   * ```ts
   * // User chose cooking, but wants to try coding path
   * await context.restore('before-choice');
   *
   * context.set(user('I want to learn coding.'));
   * context.set(assistant('Python is a great starting language!'));
   * await context.save();
   * ```
   */
  public async restore(name: string): Promise<BranchInfo> {
    await this.#ensureInitialized();

    const checkpoint = await this.#store.getCheckpoint(this.#chatId, name);
    if (!checkpoint) {
      throw new Error(
        `Checkpoint "${name}" not found in chat "${this.#chatId}"`,
      );
    }

    // Rewind to the checkpoint's message
    return this.rewind(checkpoint.messageId);
  }

  /**
   * Switch to a different branch by name.
   *
   * @param name - Branch name to switch to
   *
   * @example
   * ```ts
   * // List branches (via store)
   * const branches = await store.listBranches(context.chatId);
   * console.log(branches); // [{name: 'main', ...}, {name: 'main-v2', ...}]
   *
   * // Switch to original branch
   * await context.switchBranch('main');
   * ```
   */
  public async switchBranch(name: string): Promise<void> {
    await this.#ensureInitialized();

    const branch = await this.#store.getBranch(this.#chatId, name);
    if (!branch) {
      throw new Error(`Branch "${name}" not found in chat "${this.#chatId}"`);
    }

    await this.#store.setActiveBranch(this.#chatId, branch.id);
    this.#branch = { ...branch, isActive: true };
    this.#branchName = name;

    // Clear pending messages (they were for the old branch)
    this.#pendingMessages = [];
  }

  /**
   * Update metadata for the current chat.
   *
   * @param updates - Partial metadata to merge (title, metadata)
   *
   * @example
   * ```ts
   * await context.updateChat({
   *   title: 'Coding Help Session',
   *   metadata: { tags: ['python', 'debugging'] }
   * });
   * ```
   */
  public async updateChat(
    updates: Partial<Pick<ChatMeta, 'title' | 'metadata'>>,
  ): Promise<void> {
    await this.#ensureInitialized();

    const now = Date.now();
    const storeUpdates: Partial<
      Pick<ChatData, 'title' | 'metadata' | 'updatedAt'>
    > = {
      updatedAt: now,
    };

    if (updates.title !== undefined) {
      storeUpdates.title = updates.title;
    }
    if (updates.metadata !== undefined) {
      // Merge with existing metadata
      storeUpdates.metadata = {
        ...this.#chatData?.metadata,
        ...updates.metadata,
      };
    }

    await this.#store.updateChat(this.#chatId, storeUpdates);

    // Update local cache
    if (this.#chatData) {
      if (storeUpdates.title !== undefined) {
        this.#chatData.title = storeUpdates.title;
      }
      if (storeUpdates.metadata !== undefined) {
        this.#chatData.metadata = storeUpdates.metadata;
      }
      this.#chatData.updatedAt = now;
    }
  }

  /**
   * Consolidate context fragments (no-op for now).
   *
   * This is a placeholder for future functionality that merges context fragments
   * using specific rules. Currently, it does nothing.
   *
   * @experimental
   */
  public consolidate(): void {
    return void 0;
  }
}

export function hint(text: string): ContextFragment {
  return {
    name: 'hint',
    data: text,
  };
}

export function fragment(
  name: string,
  ...children: ContextFragment[]
): ContextFragment {
  return {
    name,
    data: children,
  };
}

/**
 * Create a role fragment for system prompt instructions.
 */
export function role(content: string): ContextFragment {
  return {
    name: 'role',
    data: content,
  };
}

/**
 * Create a user message fragment.
 * Message fragments are separated from regular fragments during resolve().
 *
 * @param content - The message content
 * @param options - Optional settings (id)
 *
 * @example
 * ```ts
 * context.set(user('Hello'));                     // Auto-generated ID
 * context.set(user('Hello', { id: 'msg-1' }));   // Custom ID
 * ```
 */
export function user(
  content: string,
  options?: MessageOptions,
): ContextFragment {
  return {
    id: options?.id ?? crypto.randomUUID(),
    name: 'user',
    data: content,
    type: 'message',
    persist: true,
  };
}

/**
 * Create an assistant message fragment.
 * Message fragments are separated from regular fragments during resolve().
 *
 * @param content - The message content
 * @param options - Optional settings (id)
 *
 * @example
 * ```ts
 * context.set(assistant('Hi there!'));                    // Auto-generated ID
 * context.set(assistant('Hi there!', { id: 'resp-1' })); // Custom ID
 * ```
 */
export function assistant(
  content: string,
  options?: MessageOptions,
): ContextFragment {
  return {
    id: options?.id ?? crypto.randomUUID(),
    name: 'assistant',
    data: content,
    type: 'message',
    persist: true,
  };
}
