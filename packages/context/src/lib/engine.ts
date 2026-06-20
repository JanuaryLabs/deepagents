import {
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type Tool,
  type UIMessage,
  convertToModelMessages,
  generateId,
  validateUIMessages,
} from 'ai';

import { type ChainSummary, ChainSummaryBuilder } from './chain-summary.ts';
import {
  type EstimateResult,
  type FragmentEstimate,
  getModelsRegistry,
} from './estimate.ts';
import {
  type ChatMessage,
  type ContextFragment,
  assistant,
  getFragmentData,
  isMessageFragment,
  toMessageFragment,
} from './fragments.ts';
import {
  type BaseWhenCtx,
  type ConditionalReminder,
  type WhenContext,
  applyRemindersToToolOutput,
  isConditionalReminder,
  synthesizeSteerUserMessage,
  user,
} from './fragments/message/user.ts';
import type { Models } from './models.generated.ts';
import {
  type ContextRenderer,
  XmlRenderer,
} from './renderers/abstract.renderer.ts';
import {
  FragmentLoaderResolver,
  type ValueResolver,
  defaultResolvers,
} from './resolvers/index.ts';
import type { AgentSandbox } from './sandbox/types.ts';
import { evaluateFiredReminders } from './save/reminder-eval.ts';
import { SavePipeline, type SaveResult } from './save/save-pipeline.ts';
import type { SkillPathMapping } from './skills/types.ts';
import { InMemoryContextStore } from './store/memory.store.ts';
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
import { extractPlainText } from './text.ts';
import { requireUIMessage } from './ui-message-guards.ts';

export type { SaveResult } from './save/save-pipeline.ts';

/**
 * Result of resolving context - ready for AI SDK consumption.
 */
export interface ResolveResult {
  /** Rendered non-message fragments for system prompt */
  systemPrompt: string;
  /** Message fragments decoded to AI SDK format */
  messages: UIMessage[];
}

/**
 * Options for resolve().
 */
export interface ResolveOptions {
  /** Renderer to use for system prompt (defaults to XmlRenderer) */
  renderer: ContextRenderer;
  /**
   * Sandbox forwarded to resolvers that declare `requiresSandbox`. Optional —
   * required only if fragments contain values that dispatch to such resolvers
   * (default chain: AsyncResolver, FunctionResolver, GeneratorResolver). Walker
   * throws pre-dispatch with the fragment path otherwise.
   */
  sandbox?: AgentSandbox;
  /** Optional cancellation signal forwarded to loaders */
  signal?: AbortSignal;
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
  /** Custom resolver chain (defaults to async, generator, function, promise, iterable) */
  resolvers?: ValueResolver[];
}

function estimateMessageContent(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data);
}

function isLanguageModelUsage(value: unknown): value is LanguageModelUsage {
  return typeof value === 'object' && value !== null && 'totalTokens' in value;
}

function addUsageValue(
  current: number | undefined,
  next: number | undefined,
): number | undefined {
  if (current === undefined && next === undefined) {
    return undefined;
  }

  return (current ?? 0) + (next ?? 0);
}

function mergeLanguageModelUsage(
  current: LanguageModelUsage | undefined,
  next: LanguageModelUsage,
): LanguageModelUsage {
  return {
    inputTokens: addUsageValue(current?.inputTokens, next.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addUsageValue(
        current?.inputTokenDetails?.noCacheTokens,
        next.inputTokenDetails?.noCacheTokens,
      ),
      cacheReadTokens: addUsageValue(
        current?.inputTokenDetails?.cacheReadTokens,
        next.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: addUsageValue(
        current?.inputTokenDetails?.cacheWriteTokens,
        next.inputTokenDetails?.cacheWriteTokens,
      ),
    },
    outputTokens: addUsageValue(current?.outputTokens, next.outputTokens),
    outputTokenDetails: {
      textTokens: addUsageValue(
        current?.outputTokenDetails?.textTokens,
        next.outputTokenDetails?.textTokens,
      ),
      reasoningTokens: addUsageValue(
        current?.outputTokenDetails?.reasoningTokens,
        next.outputTokenDetails?.reasoningTokens,
      ),
    },
    totalTokens: addUsageValue(current?.totalTokens, next.totalTokens),
    reasoningTokens: addUsageValue(
      current?.reasoningTokens,
      next.reasoningTokens,
    ),
    cachedInputTokens: addUsageValue(
      current?.cachedInputTokens,
      next.cachedInputTokens,
    ),
    raw: next.raw ?? current?.raw,
  };
}

function isSkillPathMapping(value: unknown): value is SkillPathMapping {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).description === 'string' &&
    typeof (value as Record<string, unknown>).host === 'string' &&
    typeof (value as Record<string, unknown>).sandbox === 'string'
  );
}

function isEmptyAssistantPlaceholder(message: UIMessage): boolean {
  return message.role === 'assistant' && message.parts.length === 0;
}

interface SteerFire {
  /** Step index the steer fired after (its segment boundary). */
  afterStep: number;
  /** Index in the model `messages` array where the synth was spliced at fire. */
  spliceIndex: number;
  synth: UIMessage & { role: 'user' };
  synthModel: ModelMessage[];
}

interface SteerWhenBase {
  base: BaseWhenCtx;
  content: string;
  currentMessage: UIMessage;
  lastAssistantMessage?: UIMessage;
  lastAssistantMessages?: UIMessage[];
  chainFiredOnceIds: ReadonlySet<string>;
}

/**
 * Per-stream steer state. The session OBJECT is closure-local to each
 * createSteerPrepareStep() call; only the `#currentSteerSession` POINTER lives
 * on the engine, so writeAssistantSegment can find the active session.
 *
 * A guardrail retry creates a new session and repoints `#currentSteerSession`,
 * but the retry restart (`#createRawStream`) runs only AFTER the prior stream's
 * writeAssistantSegment has persisted its fires — so the pointer reset never
 * races a carve (covered by the steer+guardrail-retry integration test).
 * Running two concurrent streams on ONE engine instance is unsupported.
 */
interface SteerSession {
  /** Durable-once ids fired in THIS stream (∪ persisted ids = suppression set). */
  firedOnceIds: Set<string>;
  fired: SteerFire[];
  whenBase?: SteerWhenBase;
  /** Id of the open (still-growing) assistant segment. */
  currentSegId?: string;
  /** Part index in the cumulative response where the open segment starts. */
  currentSegStart: number;
  /** How many fired steers have been split into the chain. */
  materialized: number;
}

function stepStartPartIndices(parts: UIMessage['parts']): number[] {
  const indices: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === 'step-start') indices.push(i);
  }
  return indices;
}

function spliceSteerMessages(
  messages: ModelMessage[],
  fired: SteerFire[],
): ModelMessage[] {
  const ordered = [...fired].sort((a, b) => a.spliceIndex - b.spliceIndex);
  const out = [...messages];
  let offset = 0;
  for (const fire of ordered) {
    out.splice(fire.spliceIndex + offset, 0, ...fire.synthModel);
    offset += fire.synthModel.length;
  }
  return out;
}

/**
 * Options for context inspection.
 */
export interface InspectOptions {
  /** Model ID for cost estimation (required) */
  modelId: Models;
  /** Renderer for estimation (required) */
  renderer: ContextRenderer;
  /**
   * Sandbox forwarded to the resolver chain via estimate(). Optional —
   * required only if fragments contain values that dispatch to resolvers
   * declaring `requiresSandbox`.
   */
  sandbox?: AgentSandbox;
  /** Optional cancellation signal forwarded to loaders */
  signal?: AbortSignal;
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
  #loaderResolver: FragmentLoaderResolver;

  get #activeBranch(): BranchData {
    if (!this.#branch) {
      throw new Error(
        'Branch not initialized. Call #ensureInitialized() first.',
      );
    }
    return this.#branch;
  }

  get #renderableFragments(): ContextFragment[] {
    return this.#fragments.filter((f) => !isConditionalReminder(f));
  }

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
    this.#loaderResolver = new FragmentLoaderResolver(
      options.resolvers ?? defaultResolvers(),
    );
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

    const branch = await this.#store.getActiveBranch(this.#chatId);
    if (!branch) {
      throw new Error(
        `Active branch not found for chat "${this.#chatId}" after upsertChat`,
      );
    }
    this.#branch = branch;

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
  public get chat(): StoredChatData | null {
    return this.#chatData;
  }

  /**
   * Count user turns in the conversation and return the previous saved user message context.
   * Includes persisted messages and pending messages in the turn count.
   */
  async #getChainContext(): Promise<ChainSummary> {
    await this.#ensureInitialized();

    const builder = new ChainSummaryBuilder();
    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      for (const msg of chain) builder.ingestStored(msg);
    }
    for (const fragment of this.#pendingMessages)
      builder.ingestPending(fragment);
    return builder.build();
  }

  public async getTurnCount(): Promise<number> {
    const { turn } = await this.#getChainContext();
    return turn;
  }

  public async firstUserMessage(): Promise<UIMessage | undefined> {
    await this.#ensureInitialized();

    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      for (const msg of chain) {
        if (msg.name === 'user') {
          return requireUIMessage(msg.data, `Stored user message "${msg.id}"`);
        }
      }
    }

    for (const fragment of this.#pendingMessages) {
      if (fragment.name !== 'user') continue;
      if (!fragment.codec) {
        throw new Error(`Fragment "${fragment.name}" is missing codec.`);
      }
      return requireUIMessage(
        fragment.codec.encode(),
        `Pending fragment "${fragment.name}"`,
      );
    }

    return undefined;
  }

  /**
   * Return the head of the conversation — pending tail or persisted branch head.
   *
   * Includes empty assistant placeholders (use this for id-lookup, not for
   * building model prompts — see `getMessages()` for prompt-ready output).
   *
   * @throws if the pending tail is missing an id (programming error).
   */
  public async headMessage(): Promise<
    { id: string; name: string } | undefined
  > {
    await this.#ensureInitialized();

    if (this.#pendingMessages.length > 0) {
      const tail = this.#pendingMessages[this.#pendingMessages.length - 1];
      if (!tail.id) {
        throw new Error(
          `headMessage: pending fragment "${tail.name}" is missing id`,
        );
      }
      return { id: tail.id, name: tail.name };
    }

    if (this.#branch?.headMessageId) {
      const msg = await this.#store.getMessage(this.#branch.headMessageId);
      if (msg) return { id: msg.id, name: msg.name };
    }

    return undefined;
  }

  /**
   * Return the model-ready conversation: persisted chain plus pending fragments,
   * with empty assistant placeholders filtered out.
   *
   * For id-lookup use `headMessage()` instead — that one keeps placeholders.
   */
  public async getMessages(): Promise<UIMessage[]> {
    await this.#ensureInitialized();

    const messages: UIMessage[] = [];

    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      for (const msg of chain) {
        const data = requireUIMessage(msg.data, `Stored message "${msg.id}"`);
        if (isEmptyAssistantPlaceholder(data)) continue;
        messages.push(data);
      }
    }

    for (const fragment of this.#pendingMessages) {
      if (!fragment.codec) {
        throw new Error(`Fragment "${fragment.name}" is missing codec.`);
      }
      const encoded = requireUIMessage(
        fragment.codec.encode(),
        `Pending fragment "${fragment.name}"`,
      );
      if (isEmptyAssistantPlaceholder(encoded)) continue;
      messages.push(encoded);
    }

    return messages.length === 0 ? [] : validateUIMessages({ messages });
  }

  /**
   * Advance the conversation by one turn. Required setup before `chat()`.
   *
   * - User input → persists the message AND appends an empty assistant
   *   placeholder reserving the id of the next streamed response.
   * - Assistant input (tool-resume / continuation) → persists in-place
   *   (`branch: false`), reusing the input's id.
   *
   * Always leaves the chain head as an assistant fragment, satisfying chat()'s
   * precondition.
   *
   * @returns the assistant id that will receive the streamed response — useful
   *   for telemetry, optimistic UI, or correlating logs before the stream starts.
   * @throws if assistant input is missing an id.
   *
   * @example
   * ```ts
   * const assistantId = await context.continue(user('hi'));
   * const stream = await chat(agent); // streams into assistantId
   * ```
   */
  public async continue(input: ChatMessage): Promise<string> {
    const fragment = toMessageFragment(input);
    const isAssistantUpdate = fragment.name === 'assistant';
    let assistantId: string;
    if (isAssistantUpdate) {
      if (!fragment.id) {
        throw new Error('continue: assistant input is missing id');
      }
      assistantId = fragment.id;
      this.set(fragment);
    } else {
      assistantId = generateId();
      this.set(
        fragment,
        assistant({ id: assistantId, role: 'assistant', parts: [] }),
      );
    }
    await this.save({ branch: !isAssistantUpdate });
    return assistantId;
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
    return renderer.render(this.#renderableFragments);
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
    await this.#loaderResolver.resolve(this.#fragments, {
      sandbox: options.sandbox,
      context: this,
      signal: options.signal,
    });
    const systemPrompt = options.renderer.render(this.#renderableFragments);
    const messages = await this.getMessages();
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

    const pipeline = new SavePipeline(
      this.#asSavePipelineEngine(),
      this.#pendingMessages,
      this.#fragments,
    );
    await pipeline.applyUpdateBranching(options?.branch ?? true);
    await pipeline.evaluateUserReminders();
    const result = await pipeline.persist();

    this.#pendingMessages = [];
    return result;
  }

  #currentSteerSession: SteerSession | undefined;

  /**
   * Build the `prepareStep` hook that injects steer reminders mid-loop.
   *
   * Semantics are "inject once, persist": when a steer reminder's predicate
   * fires (only after the model has produced ≥1 step with content — the mid-loop
   * gate), its `<system-reminder>` user message is spliced into the model prompt
   * at the step boundary where it fired AND re-spliced on every subsequent step,
   * so the model keeps seeing it for the rest of the loop.
   *
   * Firing is edge-triggered with a post-fire re-sample: each fire resets the
   * elapsed reference (`lastSyntheticAt`), then the config is immediately
   * re-evaluated against the reset context — self-resetting predicates like
   * `elapsedExceeds` read false and re-arm (so they recur every N within one
   * stream), while constant predicates like `everyNTurns` read true and disarm
   * (so they fire once per stream). Any later false sample re-arms a config.
   * All state is closure-local (a fresh SteerSession per call), so overlapping
   * streams / guardrail retries never share a cursor.
   *
   * The session is also consumed by writeAssistantSegment, which carves the
   * streamed assistant message into the matching `[assistant, steer, assistant]`
   * split — so the stored chain reproduces exactly the prompt the model saw
   * (store/prompt parity).
   */
  public createSteerPrepareStep<
    TOOLS extends Record<string, Tool> = Record<string, Tool>,
  >(): PrepareStepFunction<TOOLS> {
    const session: SteerSession = {
      firedOnceIds: new Set(),
      fired: [],
      currentSegStart: 0,
      materialized: 0,
    };
    this.#currentSteerSession = session;

    return async ({ steps, stepNumber, messages }) => {
      // Mid-loop only: never fire before the model has produced a step with
      // content, so a synthetic steer user is always preceded by an assistant
      // turn (valid user→assistant→steer→assistant alternation, no 400).
      const priorStep = stepNumber >= 1 ? steps[stepNumber - 1] : undefined;
      const canFire = (priorStep?.content?.length ?? 0) > 0;

      if (canFire) {
        const configs = this.#steerConfigs();
        if (configs.length > 0) {
          const whenCtx = await this.#steerWhenCtx(session);
          const matched = await evaluateFiredReminders(configs, whenCtx);
          if (matched.length > 0) {
            const onceIds = [...new Set(matched.flatMap((m) => m.onceIds))];
            for (const id of onceIds) session.firedOnceIds.add(id);
            const synth = synthesizeSteerUserMessage(
              matched.map((m) => m.resolved.text),
              Date.now(),
              onceIds,
            );
            const synthModel = await convertToModelMessages([synth] as never, {
              ignoreIncompleteToolCalls: true,
            });
            session.fired.push({
              afterStep: stepNumber - 1,
              spliceIndex: messages.length,
              synth,
              synthModel,
            });
          }
        }
      }

      if (session.fired.length === 0) return undefined;
      return {
        messages: spliceSteerMessages(
          messages as ModelMessage[],
          session.fired,
        ),
      };
    };
  }

  /**
   * Persist the streamed assistant message, carving it into the steer split when
   * steer reminders fired this turn.
   *
   * Called from chat()'s onStepFinish/onFinish (and the guardrail path) with the
   * cumulative response message. Segment boundaries come from the `step-start`
   * markers in the message itself — no cross-track store read — so the carve is
   * race-free. Idempotent: finalized segments keep stable ids; the open segment
   * is updated in place. With no active steer it degrades to a plain in-place
   * write of the whole message to the reserved head.
   */
  public async writeAssistantSegment(message: UIMessage): Promise<void> {
    const head = await this.headMessage();
    if (head?.name !== 'assistant') {
      throw new Error(
        'writeAssistantSegment: expected an assistant message at chain head.',
      );
    }

    const session = this.#currentSteerSession;
    if (!session || session.fired.length === 0) {
      this.set(assistant({ ...message, id: head.id } as UIMessage));
      await this.save({ branch: false });
      return;
    }

    if (session.currentSegId === undefined) {
      session.currentSegId = head.id;
      session.currentSegStart = 0;
    }

    const stepStarts = stepStartPartIndices(message.parts);

    while (session.materialized < session.fired.length) {
      const fire = session.fired[session.materialized];
      const boundary = stepStarts[fire.afterStep + 1];
      if (boundary === undefined) break; // post-steer step hasn't streamed yet

      this.set(
        assistant({
          id: session.currentSegId,
          role: 'assistant',
          parts: message.parts.slice(session.currentSegStart, boundary),
        } as UIMessage),
      );
      this.set(user(fire.synth));
      session.currentSegId = generateId();
      session.currentSegStart = boundary;
      session.materialized++;
    }

    this.set(
      assistant({
        ...message,
        id: session.currentSegId,
        parts: message.parts.slice(session.currentSegStart),
      } as UIMessage),
    );
    await this.save({ branch: false });
  }

  #steerConfigs(): ConditionalReminder[] {
    return this.#fragments
      .filter(isConditionalReminder)
      .map((fragment) => fragment.metadata.reminder)
      .filter((config) => config.target === 'steer');
  }

  async #steerWhenCtx(session: SteerSession): Promise<WhenContext> {
    await this.#ensureInitialized();
    if (!session.whenBase) {
      const chain = await this.#getChainContext();
      const base = this.#asSavePipelineEngine().buildBaseWhenCtx(chain);
      const currentMessage = chain.lastMessage;
      if (!currentMessage) {
        throw new Error(
          'steer reminders require a user message earlier in the turn',
        );
      }
      session.whenBase = {
        base,
        content: extractPlainText(currentMessage),
        currentMessage,
        lastAssistantMessage: chain.lastAssistantMessage,
        lastAssistantMessages: chain.lastAssistantMessages,
        chainFiredOnceIds: chain.firedOnceIds,
      };
    }

    const {
      base,
      content,
      currentMessage,
      lastAssistantMessage,
      lastAssistantMessages,
      chainFiredOnceIds,
    } = session.whenBase;

    // elapsed measures from the last real user message; synthetic steer nudges
    // do not advance it (chain-summary excludes them). Within a stream the
    // reference is frozen at stream start, so a raw elapsedExceeds keeps firing
    // every step once crossed — that is by design; compose once() for control.
    const elapsed =
      base.lastMessageAt !== undefined
        ? Date.now() - base.lastMessageAt
        : undefined;

    return {
      ...base,
      elapsed,
      content,
      currentMessage,
      lastAssistantMessage,
      lastAssistantMessages,
      firedOnceIds: new Set([...chainFiredOnceIds, ...session.firedOnceIds]),
    };
  }

  /**
   * Evaluate `target: 'tool-output'` reminders against a tool's raw result and
   * return the (possibly wrapped) output.
   *
   * Called by the agent's tool wrapper right after each `execute()` resolves —
   * upstream of both the model and the store, so the next model step and the
   * persisted chain see the exact same wrapped value (store/prompt parity).
   *
   * Returns the output unchanged when no tool-output reminder fires. Without a
   * persisted user message there is no turn context to evaluate against
   * (e.g. asTool forks that set a pending user without saving), so the output
   * passes through untouched.
   */
  public async applyToolOutputReminders(output: unknown): Promise<unknown> {
    const configs = this.#fragments
      .filter(isConditionalReminder)
      .map((fragment) => fragment.metadata.reminder)
      .filter((config) => config.target === 'tool-output');
    if (configs.length === 0) return output;

    await this.#ensureInitialized();
    const chain = await this.#getChainContext();
    const currentMessage = chain.lastMessage;
    if (!currentMessage) return output;

    const base = this.#asSavePipelineEngine().buildBaseWhenCtx(chain);
    const whenCtx: WhenContext = {
      ...base,
      content: extractPlainText(currentMessage),
      currentMessage,
      lastAssistantMessage: chain.lastAssistantMessage,
      lastAssistantMessages: chain.lastAssistantMessages,
    };

    const matched = await evaluateFiredReminders(configs, whenCtx);
    if (matched.length === 0) return output;

    return applyRemindersToToolOutput(
      output,
      matched.map((m) => m.resolved.text),
    );
  }

  #asSavePipelineEngine() {
    return {
      store: this.#store,
      chatId: this.#chatId,
      branchName: this.#branchName,
      getActiveBranch: () => ({
        id: this.#activeBranch.id,
        headMessageId: this.#activeBranch.headMessageId,
      }),
      commitHead: async (headMessageId: string) => {
        await this.#store.updateBranchHead(
          this.#activeBranch.id,
          headMessageId,
        );
        this.#activeBranch.headMessageId = headMessageId;
      },
      rewindForUpdate: (parentId: string) => this.#rewindForUpdate(parentId),
      getChainSummary: () => this.#getChainContext(),
      buildBaseWhenCtx: (chain: ChainSummary): BaseWhenCtx => {
        const rawUsage = this.#chatData?.metadata?.usage;
        const usage = isLanguageModelUsage(rawUsage) ? rawUsage : undefined;
        const elapsed =
          chain.lastMessageAt !== undefined
            ? Date.now() - chain.lastMessageAt
            : undefined;
        const chatData = this.#chatData;
        if (!chatData) {
          throw new Error(
            'ContextEngine must be initialized before reminders run',
          );
        }
        return {
          turn: chain.turn,
          messageCount: chain.messageCount,
          lastMessageAt: chain.lastMessageAt,
          lastMessage: chain.lastMessage,
          chat: chatData,
          usage,
          branch: this.#branchName,
          elapsed,
        };
      },
    };
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
      sandbox?: AgentSandbox;
      signal?: AbortSignal;
    } = {},
  ): Promise<EstimateResult> {
    await this.#ensureInitialized();
    await this.#loaderResolver.resolve(this.#fragments, {
      sandbox: options.sandbox,
      context: this,
      signal: options.signal,
    });

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

    // 1. Estimate context fragments (system prompt), skip conditional reminders
    for (const fragment of this.#renderableFragments) {
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
        const content = estimateMessageContent(msg.data);
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
      const content = estimateMessageContent(
        fragment.codec ? fragment.codec.encode() : getFragmentData(fragment),
      );
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
    updates: Partial<Pick<StoredChatData, 'title' | 'metadata'>>,
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

    const storedUsage = freshChatData?.metadata?.usage;
    const currentUsage = isLanguageModelUsage(storedUsage)
      ? storedUsage
      : undefined;
    const updatedUsage = mergeLanguageModelUsage(currentUsage, usage);

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
   * Create an isolated child context with the same system-prompt fragments
   * but a fresh in-memory store and no message history.
   *
   * Useful for one-shot agent invocations (e.g., `asTool()`) that need
   * the parent's context fragments without sharing conversation state.
   *
   * @returns A new ContextEngine with copied fragments and empty message history
   */
  public fork(): ContextEngine {
    const child = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: crypto.randomUUID(),
      userId: this.#userId,
    });
    child.set(...this.#fragments);
    return child;
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
      const mounts = fragment.metadata?.mounts;
      if (
        fragment.name === 'available_skills' &&
        Array.isArray(mounts) &&
        mounts.every(isSkillPathMapping)
      ) {
        return { mounts };
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

    const estimateResult = await this.estimate(options.modelId, {
      renderer,
      sandbox: options.sandbox,
      signal: options.signal,
    });

    // Render using provided renderer (exclude conditional reminders)
    const rendered = renderer.render(this.#renderableFragments);

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
