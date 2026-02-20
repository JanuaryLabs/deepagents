import type { LanguageModelUsage } from 'ai';
import { mergeWith } from 'lodash-es';

import {
  type EstimateResult,
  type FragmentEstimate,
  getModelsRegistry,
} from './estimate.ts';
import type { ContextFragment, LazyFragment } from './fragments.ts';
import {
  LAZY_ID,
  assistantText,
  isLazyFragment,
  isMessageFragment,
  message,
} from './fragments.ts';
import type { Models } from './models.generated.ts';
import {
  type ContextRenderer,
  XmlRenderer,
} from './renderers/abstract.renderer.ts';
import type { SkillPathMapping } from './skills/types.ts';
import {
  type BranchData,
  type BranchInfo,
  type ChatData,
  type CheckpointData,
  type CheckpointInfo,
  ContextStore,
  type GraphData,
  type MessageData,
  type StoredChatData,
} from './store/store.ts';

/**
 * Result of resolving context - ready for AI SDK consumption.
 */
export interface ResolveResult {
  /** Rendered non-message fragments for system prompt */
  systemPrompt: string;
  /** Message fragments decoded to AI SDK format */
  messages: unknown[];
}

/**
 * Options for resolve().
 */
export interface ResolveOptions {
  /** Renderer to use for system prompt (defaults to XmlRenderer) */
  renderer: ContextRenderer;
}

/**
 * Result of saving pending messages to the graph.
 */
export interface SaveResult {
  headMessageId: string | undefined;
}

/**
 * Options for creating a ContextEngine.
 */
export interface ContextEngineOptions {
  /** Store for persisting fragments (required) */
  store: ContextStore;
  /** Unique identifier for this chat (required) */
  chatId: string;
  /** User who owns this chat (required) */
  userId: string;
  /** Optional initial metadata for the chat (merged with existing if chat exists) */
  metadata?: Record<string, unknown>;
}

/**
 * Metadata about a chat.
 */
export interface ChatMeta {
  /** Unique chat identifier */
  id: string;
  /** User who owns this chat */
  userId: string;
  /** When the chat was created */
  createdAt: number;
  /** When the chat was last updated */
  updatedAt: number;
  /** Optional user-provided title */
  title?: string;
  /** Optional custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for context inspection.
 */
export interface InspectOptions {
  /** Model ID for cost estimation (required) */
  modelId: Models;
  /** Renderer for estimation (required) */
  renderer: ContextRenderer;
}

/**
 * Result of inspecting context state.
 * JSON-serializable snapshot for debugging.
 */
export interface InspectResult {
  /** Token usage and cost estimation */
  estimate: EstimateResult;
  /** Rendered output using the provided renderer */
  rendered: string;
  /** Fragment structure breakdown */
  fragments: {
    /** Non-message fragments (role, hints, etc.) */
    context: ContextFragment[];
    /** Pending messages not yet saved to store */
    pending: ContextFragment[];
    /** Persisted messages from the store */
    persisted: MessageData[];
  };
  /** Conversation graph with branches and checkpoints */
  graph: GraphData;
  /** Inspection metadata */
  meta: {
    chatId: string;
    branch: string;
    timestamp: number;
  };
}

/**
 * Context engine for managing AI conversation context with graph-based storage.
 *
 * The engine uses a DAG (Directed Acyclic Graph) model for messages:
 * - Messages are immutable nodes with parentId forming the graph
 * - Branches are pointers to head (tip) messages
 * - Checkpoints are pointers to specific messages
 * - History is preserved through branching (rewind creates new branch)
 */
export class ContextEngine {
  /** Non-message fragments (role, hints, etc.) - not persisted in graph */
  #fragments: ContextFragment[] = [];
  /** Pending message fragments to be added to graph */
  #pendingMessages: ContextFragment[] = [];
  #store: ContextStore;
  #chatId: string;
  #userId: string;
  #branchName: string;
  #branch: BranchData | null = null;
  #chatData: StoredChatData | null = null;
  #initialized = false;
  /** Initial metadata to merge on first initialization */
  #initialMetadata: Record<string, unknown> | undefined;

  constructor(options: ContextEngineOptions) {
    if (!options.chatId) {
      throw new Error('chatId is required');
    }
    if (!options.userId) {
      throw new Error('userId is required');
    }
    this.#store = options.store;
    this.#chatId = options.chatId;
    this.#userId = options.userId;
    this.#branchName = 'main';
    this.#initialMetadata = options.metadata;
  }

  /**
   * Initialize the chat and branch if they don't exist.
   */
  async #ensureInitialized(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    this.#chatData = await this.#store.upsertChat({
      id: this.#chatId,
      userId: this.#userId,
    });

    // Merge initial metadata if provided (handles both new and existing chats)
    if (this.#initialMetadata) {
      this.#chatData = await this.#store.updateChat(this.#chatId, {
        metadata: {
          ...this.#chatData.metadata,
          ...this.#initialMetadata,
        },
      });
      // Clear after use to prevent memory leak
      this.#initialMetadata = undefined;
    }

    // "main" branch is guaranteed to exist after upsertChat
    this.#branch = (await this.#store.getActiveBranch(this.#chatId))!;

    this.#initialized = true;
  }

  /**
   * Create a new branch from a specific message.
   * Shared logic between rewind() and btw().
   */
  async #createBranchFrom(
    messageId: string,
    switchTo: boolean,
  ): Promise<BranchInfo> {
    // Generate branch name based on same-prefix count (e.g., main-v2, main-v3)
    const branches = await this.#store.listBranches(this.#chatId);
    const samePrefix = branches.filter(
      (it) =>
        it.name === this.#branchName ||
        it.name.startsWith(`${this.#branchName}-v`),
    );
    const newBranchName = `${this.#branchName}-v${samePrefix.length + 1}`;

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

    if (switchTo) {
      // Switch to the new branch
      await this.#store.setActiveBranch(this.#chatId, newBranch.id);
      this.#branch = { ...newBranch, isActive: true };
      this.#branchName = newBranchName;
      // Clear pending messages (they were for the old branch)
      this.#pendingMessages = [];
    }

    // Get message count for branch info
    const chain = await this.#store.getMessageChain(messageId);

    return {
      id: newBranch.id,
      name: newBranch.name,
      headMessageId: newBranch.headMessageId,
      isActive: switchTo,
      messageCount: chain.length,
      createdAt: newBranch.createdAt,
    };
  }

  /**
   * Rewind to a message without clearing pending messages.
   * Used internally when saving an update to an existing message.
   */
  async #rewindForUpdate(messageId: string): Promise<void> {
    const pendingBackup = [...this.#pendingMessages];
    await this.rewind(messageId);
    this.#pendingMessages = pendingBackup;
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
   * Get the current branch head message ID.
   * Returns undefined if no messages have been saved yet.
   */
  public get headMessageId(): string | undefined {
    return this.#branch?.headMessageId ?? undefined;
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
      userId: this.#chatData.userId,
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
        this.#fragments.push(fragment);
      }
    }
    return this;
  }

  // Unset a fragment by ID (not implemented yet)
  public unset(fragmentId: string) {
    //
  }

  /**
   * Render all fragments using the provided renderer.
   * @internal Use resolve() instead for public API.
   */
  public render(renderer: ContextRenderer) {
    return renderer.render(this.#fragments);
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
   * const context = new ContextEngine({ store, chatId: 'chat-1', userId: 'user-1' })
   *   .set(role('You are helpful'), user('Hello'));
   *
   * const { systemPrompt, messages } = await context.resolve();
   * await generateText({ system: systemPrompt, messages });
   * ```
   */
  public async resolve(options: ResolveOptions): Promise<ResolveResult> {
    await this.#ensureInitialized();

    const systemPrompt = options.renderer.render(this.#fragments);

    // Get persisted messages from graph
    const messages: unknown[] = [];
    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );

      for (const msg of chain) {
        messages.push(message(msg.data as never).codec?.decode());
      }
    }

    // Add pending messages (not yet saved)
    // Resolve any lazy fragments first (like save() does)
    for (let i = 0; i < this.#pendingMessages.length; i++) {
      const fragment = this.#pendingMessages[i];
      if (isLazyFragment(fragment)) {
        this.#pendingMessages[i] = await this.#resolveLazyFragment(fragment);
      }
    }

    for (const fragment of this.#pendingMessages) {
      if (!fragment.codec) {
        throw new Error(
          `Fragment "${fragment.name}" is missing codec. Lazy fragments must be resolved before decode.`,
        );
      }
      const decoded = fragment.codec.decode();
      messages.push(decoded);
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
  public async save(options?: { branch?: boolean }): Promise<SaveResult> {
    await this.#ensureInitialized();

    if (this.#pendingMessages.length === 0) {
      return { headMessageId: this.#branch?.headMessageId ?? undefined };
    }

    const shouldBranch = options?.branch ?? true;

    // Resolve any lazy fragments before processing
    for (let i = 0; i < this.#pendingMessages.length; i++) {
      const fragment = this.#pendingMessages[i];
      if (isLazyFragment(fragment)) {
        this.#pendingMessages[i] = await this.#resolveLazyFragment(fragment);
      }
    }

    if (shouldBranch) {
      // Check if any fragment is an update to an existing message.
      // If so, rewind to the parent to create a new branch, preserving the original.
      for (const fragment of this.#pendingMessages) {
        if (fragment.id) {
          const existing = await this.#store.getMessage(fragment.id);
          if (existing && existing.parentId) {
            // Rewind to parent, creates new branch, preserves pending
            await this.#rewindForUpdate(existing.parentId);
            // Regenerate ID so the original message stays untouched on old branch
            fragment.id = crypto.randomUUID();
            break; // Only need to rewind once
          }
        }
      }
    }

    let parentId = this.#branch!.headMessageId;
    const now = Date.now();

    // Add each pending message to the graph
    for (const fragment of this.#pendingMessages) {
      if (!fragment.codec) {
        throw new Error(
          `Fragment "${fragment.name}" is missing codec. Lazy fragments must be resolved before encode.`,
        );
      }

      const msgId = fragment.id ?? crypto.randomUUID();

      // When updating in place, a fragment's ID may equal the current branch head.
      // Deriving parentId from the head would create a self-reference.
      // Use the existing message's original parentId instead.
      let msgParentId = parentId;
      if (!shouldBranch && msgId === parentId) {
        const existing = await this.#store.getMessage(msgId);
        if (existing) {
          msgParentId = existing.parentId;
        }
      }

      const messageData: MessageData = {
        id: msgId,
        chatId: this.#chatId,
        parentId: msgParentId,
        name: fragment.name,
        type: fragment.type,
        data: fragment.codec.encode(),
        createdAt: now,
      };

      await this.#store.addMessage(messageData);
      parentId = messageData.id;
    }

    // Update branch head to last message
    await this.#store.updateBranchHead(this.#branch!.id, parentId);
    this.#branch!.headMessageId = parentId;

    // Clear pending messages
    this.#pendingMessages = [];

    return { headMessageId: this.#branch!.headMessageId ?? undefined };
  }

  /**
   * Resolve a lazy fragment by finding the appropriate ID.
   */
  async #resolveLazyFragment(fragment: LazyFragment): Promise<ContextFragment> {
    const lazy = fragment[LAZY_ID]!;

    if (lazy.type === 'last-assistant') {
      const lastId = await this.#getLastAssistantId();
      return assistantText(lazy.content, { id: lastId ?? crypto.randomUUID() });
    }

    throw new Error(`Unknown lazy fragment type: ${lazy.type}`);
  }

  /**
   * Find the most recent assistant message ID (pending or persisted).
   */
  async #getLastAssistantId(): Promise<string | undefined> {
    // Check pending messages first (excluding lazy ones)
    for (let i = this.#pendingMessages.length - 1; i >= 0; i--) {
      const msg = this.#pendingMessages[i];
      if (msg.name === 'assistant' && !isLazyFragment(msg)) {
        return msg.id;
      }
    }

    // Check persisted messages at branch head
    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].name === 'assistant') {
          return chain[i].id;
        }
      }
    }

    return undefined;
  }

  /**
   * Estimate token count and cost for the full context.
   *
   * Includes:
   * - System prompt fragments (role, hints, etc.)
   * - Persisted chat messages (from store)
   * - Pending messages (not yet saved)
   *
   * @param modelId - Model ID (e.g., "openai:gpt-4o", "anthropic:claude-3-5-sonnet")
   * @param options - Optional settings
   * @returns Estimate result with token counts, costs, and per-fragment breakdown
   */
  public async estimate(
    modelId: Models,
    options: {
      renderer?: ContextRenderer;
    } = {},
  ): Promise<EstimateResult> {
    await this.#ensureInitialized();

    const renderer = options.renderer ?? new XmlRenderer();
    const registry = getModelsRegistry();
    await registry.load();

    const model = registry.get(modelId);
    if (!model) {
      throw new Error(
        `Model "${modelId}" not found. Call load() first or check model ID.`,
      );
    }

    const tokenizer = registry.getTokenizer(modelId);
    const fragmentEstimates: FragmentEstimate[] = [];

    // 1. Estimate context fragments (system prompt)
    for (const fragment of this.#fragments) {
      const rendered = renderer.render([fragment]);
      const tokens = tokenizer.count(rendered);
      const cost = (tokens / 1_000_000) * model.cost.input;
      fragmentEstimates.push({
        id: fragment.id,
        name: fragment.name,
        tokens,
        cost,
      });
    }

    // 2. Estimate persisted messages from store
    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      for (const msg of chain) {
        const content = String(msg.data);
        const tokens = tokenizer.count(content);
        const cost = (tokens / 1_000_000) * model.cost.input;
        fragmentEstimates.push({
          name: msg.name,
          id: msg.id,
          tokens,
          cost,
        });
      }
    }

    // 3. Estimate pending messages (not yet saved)
    for (const fragment of this.#pendingMessages) {
      const content = String(fragment.data);
      const tokens = tokenizer.count(content);
      const cost = (tokens / 1_000_000) * model.cost.input;
      fragmentEstimates.push({
        name: fragment.name,
        id: fragment.id,
        tokens,
        cost,
      });
    }

    // Calculate totals
    const totalTokens = fragmentEstimates.reduce((sum, f) => sum + f.tokens, 0);
    const totalCost = fragmentEstimates.reduce((sum, f) => sum + f.cost, 0);

    return {
      model: model.id,
      provider: model.provider,
      tokens: totalTokens,
      cost: totalCost,
      limits: {
        context: model.limit.context,
        output: model.limit.output,
        exceedsContext: totalTokens > model.limit.context,
      },
      fragments: fragmentEstimates,
    };
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

    return this.#createBranchFrom(messageId, true);
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
   * Create a parallel branch from the current position ("by the way").
   *
   * Use this when you want to fork the conversation without leaving
   * the current branch. Common use case: user wants to ask another
   * question while waiting for the model to respond.
   *
   * Unlike rewind(), this method:
   * - Uses the current HEAD (no messageId needed)
   * - Does NOT switch to the new branch
   * - Keeps pending messages intact
   *
   * @returns The new branch info (does not switch to it)
   * @throws Error if no messages exist in the conversation
   *
   * @example
   * ```ts
   * // User asked a question, model is generating...
   * context.set(user('What is the weather?'));
   * await context.save();
   *
   * // User wants to ask something else without waiting
   * const newBranch = await context.btw();
   * // newBranch = { name: 'main-v2', ... }
   *
   * // Later, switch to the new branch and add the question
   * await context.switchBranch(newBranch.name);
   * context.set(user('Also, what time is it?'));
   * await context.save();
   * ```
   */
  public async btw(): Promise<BranchInfo> {
    await this.#ensureInitialized();

    if (!this.#branch?.headMessageId) {
      throw new Error('Cannot create btw branch: no messages in conversation');
    }

    return this.#createBranchFrom(this.#branch.headMessageId, false);
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

    const storeUpdates: Partial<Pick<ChatData, 'title' | 'metadata'>> = {};

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

    this.#chatData = await this.#store.updateChat(this.#chatId, storeUpdates);
  }

  /**
   * Track token usage for the current chat.
   * Accumulates usage metrics in chat.metadata.usage.
   *
   * @param usage - Token usage from AI SDK (LanguageModelUsage)
   *
   * @example
   * ```ts
   * // In onFinish callback
   * const usage = await result.totalUsage;
   * await context.trackUsage(usage);
   * ```
   */
  public async trackUsage(usage: LanguageModelUsage): Promise<void> {
    await this.#ensureInitialized();

    // Read fresh data from store to prevent race conditions with concurrent calls
    const freshChatData = await this.#store.getChat(this.#chatId);

    // Get current usage from metadata (if any)
    const currentUsage = (freshChatData?.metadata?.usage ??
      {}) as Partial<LanguageModelUsage>;

    // Accumulate usage - recursively add all numeric fields
    const updatedUsage = mergeWith({}, currentUsage, usage, (a, b) =>
      typeof a === 'number' || typeof b === 'number'
        ? (a ?? 0) + (b ?? 0)
        : undefined,
    ) as LanguageModelUsage;

    // Update chat metadata with accumulated usage
    this.#chatData = await this.#store.updateChat(this.#chatId, {
      metadata: {
        ...freshChatData?.metadata,
        usage: updatedUsage,
      },
    });
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

  /**
   * Extract skill mounts from available_skills fragments.
   * Returns unified mount array where entries with `name` are individual skills.
   *
   * @example
   * ```ts
   * const context = new ContextEngine({ store, chatId, userId })
   *   .set(skills({ paths: [{ host: './skills', sandbox: '/skills' }] }));
   *
   * const { mounts } = context.getSkillMounts();
   * // mounts: [{ name: 'bi-dashboards', host: './skills/bi-dashboards/SKILL.md', sandbox: '/skills/bi-dashboards/SKILL.md' }]
   *
   * // Extract skills only (entries with name)
   * const skills = mounts.filter(m => m.name);
   * ```
   */
  public getSkillMounts() {
    for (const fragment of this.#fragments) {
      if (fragment.name === 'available_skills' && fragment.metadata?.mounts) {
        return { mounts: fragment.metadata.mounts as SkillPathMapping[] };
      }
    }
    return { mounts: [] };
  }

  /**
   * Inspect the full context state for debugging.
   * Returns a JSON-serializable object with context information.
   *
   * @param options - Inspection options (modelId and renderer required)
   * @returns Complete inspection data including estimates, rendered output, fragments, and graph
   *
   * @example
   * ```ts
   * const inspection = await context.inspect({
   *   modelId: 'openai:gpt-4o',
   *   renderer: new XmlRenderer(),
   * });
   * console.log(JSON.stringify(inspection, null, 2));
   *
   * // Or write to file for analysis
   * await fs.writeFile('context-debug.json', JSON.stringify(inspection, null, 2));
   * ```
   */
  public async inspect(options: InspectOptions): Promise<InspectResult> {
    await this.#ensureInitialized();

    const { renderer } = options;

    // Get token/cost estimation
    const estimateResult = await this.estimate(options.modelId, { renderer });

    // Render using provided renderer
    const rendered = renderer.render(this.#fragments);

    // Get persisted messages from store
    const persistedMessages: MessageData[] = [];
    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      persistedMessages.push(...chain);
    }

    // Get conversation graph
    const graph = await this.#store.getGraph(this.#chatId);

    return {
      estimate: estimateResult,
      rendered,
      fragments: {
        context: [...this.#fragments],
        pending: [...this.#pendingMessages],
        persisted: persistedMessages,
      },
      graph,
      meta: {
        chatId: this.#chatId,
        branch: this.#branchName,
        timestamp: Date.now(),
      },
    };
  }
}
