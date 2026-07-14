import { getErrorMessage } from '@ai-sdk/provider';
import {
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type StepResult,
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
import { user } from './fragments/message/user.ts';
import {
  type BaseWhenCtx,
  type ConditionalReminder,
  type ReminderTarget,
  type ToolOutcome,
  type WhenContext,
  applyUserRemindersToMessage,
  evaluateFiredReminders,
  isConditionalReminder,
  isSyntheticReminderMessage,
  synthesizeReminderMessage,
} from './fragments/reminders/index.ts';
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
import { SavePipeline, type SaveResult } from './save/save-pipeline.ts';
import type { AvailableSkill } from './skills/types.ts';
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
import { requireUIMessage, requireUserUIMessage } from './ui-message-guards.ts';

export type { SaveResult } from './save/save-pipeline.ts';
export { HeadConflictError } from './save/save-pipeline.ts';

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
    raw: next.raw ?? current?.raw,
  };
}

function isAvailableSkill(value: unknown): value is AvailableSkill {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).description === 'string' &&
    typeof (value as Record<string, unknown>).path === 'string'
  );
}

function isEmptyAssistantPlaceholder(message: UIMessage): boolean {
  return message.role === 'assistant' && message.parts.length === 0;
}

function toolOutcomesFromStep<TOOLS extends Record<string, Tool>>(
  content: StepResult<TOOLS>['content'],
): ToolOutcome[] {
  const outcomes: ToolOutcome[] = [];
  for (const part of content) {
    if (part.type === 'tool-result' && typeof part.toolName === 'string') {
      outcomes.push({
        state: 'output-available',
        name: part.toolName,
        input: part.input,
        output: part.output,
      });
    } else if (
      part.type === 'tool-error' &&
      typeof part.toolName === 'string'
    ) {
      outcomes.push({
        state: 'output-error',
        name: part.toolName,
        input: part.input,
        error: part.error,
        errorText: getErrorMessage(part.error),
      });
    } else if (
      part.type === 'tool-approval-response' &&
      part.approved === false
    ) {
      outcomes.push({
        state: 'output-denied',
        name: part.toolCall.toolName,
        input: part.toolCall.input,
        ...(typeof part.reason === 'string' ? { reason: part.reason } : {}),
      });
    }
  }
  return outcomes;
}

export type PrepareStepInputProvider = () =>
  | Array<UIMessage & { role: 'user' }>
  | undefined
  | Promise<Array<UIMessage & { role: 'user' }> | undefined>;

interface StepInputFire {
  /** Step index the input was injected after. */
  afterStep: number;
  messages: Array<UIMessage & { role: 'user' }>;
}

/**
 * Per-stream reminder state. The session object is closure-local to each
 * createPrepareStep() call; only the `#currentReminderSession` pointer lives on
 * the engine so writeAssistantSegment can persist the model-visible splits.
 *
 * Guardrail retries reuse the same prepare hook and session so local step
 * numbers can be mapped onto one cumulative UI message.
 * Running two concurrent streams on ONE engine instance is unsupported.
 */
interface ReminderSession {
  /** Durable once-ids fired in this stream. */
  firedOnceIds: Set<string>;
  fired: StepInputFire[];
  /** Id of the open (still-growing) assistant segment. */
  currentSegId?: string;
  /** Part index in the cumulative response where the open segment starts. */
  currentSegStart: number;
  /** How many fired reminders have been split into the chain. */
  materialized: number;
}

function stepStartPartIndices(parts: UIMessage['parts']): number[] {
  const indices: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === 'step-start') indices.push(i);
  }
  return indices;
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
  /** Retained so forked children inherit the parent's resolver chain */
  #resolvers: ValueResolver[] | undefined;

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
    this.#resolvers = options.resolvers;
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
    if (this.#chatData.userId !== this.#userId) {
      throw new Error(
        `chat "${this.#chatId}" belongs to user "${this.#chatData.userId}", not "${this.#userId}"`,
      );
    }

    // Merge initial metadata if provided (handles both new and existing chats)
    if (this.#initialMetadata) {
      const initialMetadata = this.#initialMetadata;
      this.#chatData = await this.#store.updateChat(
        this.#chatId,
        ({ metadata }) => ({
          metadata: { ...metadata, ...initialMetadata },
        }),
      );
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
   * A pending fragment that carries the id of an already-stored message is an
   * UPDATE to that message, not a new one — the store upserts by id, and this
   * must agree. Both chat() and the guardrail-retry path call
   * writeAssistantSegment for the same step, so the streamed assistant is
   * routinely persisted while a fragment for it is still pending; appending
   * blindly duplicated it in the prompt and broke store/prompt parity on the
   * next turn.
   *
   * For id-lookup use `headMessage()` instead — that one keeps placeholders.
   */
  public async getMessages(): Promise<UIMessage[]> {
    await this.#ensureInitialized();

    const messages: UIMessage[] = [];
    const indexById = new Map<string, number>();

    if (this.#branch?.headMessageId) {
      const chain = await this.#store.getMessageChain(
        this.#branch.headMessageId,
      );
      for (const msg of chain) {
        const data = requireUIMessage(msg.data, `Stored message "${msg.id}"`);
        if (isEmptyAssistantPlaceholder(data)) continue;
        indexById.set(data.id, messages.push(data) - 1);
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

      const stored = indexById.get(encoded.id);
      if (stored === undefined) {
        indexById.set(encoded.id, messages.push(encoded) - 1);
      } else {
        messages[stored] = encoded;
      }
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
   * await generateText({ instructions: systemPrompt, messages });
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

    const pending = this.#pendingMessages;
    const pipeline = new SavePipeline(this.#asSavePipelineEngine(), pending);
    await pipeline.applyUpdateBranching(options?.branch ?? true);
    await this.#foldUserReminders(pending);
    const result = await pipeline.persist();

    this.#pendingMessages = [];
    return result;
  }

  #currentReminderSession: ReminderSession | undefined;

  /**
   * Build the `prepareStep` hook that injects reminders between model steps.
   * Tool-output reminders are evaluated against the preceding step's completed
   * tool results and appended after the SDK's tool-result message. Steer
   * reminders share the same synthetic user message when both fire together.
   *
   * Each eligible boundary evaluates its reminders independently. A predicate
   * that remains true fires at every boundary; compose `once()` when a durable
   * latch is desired. AI SDK v7 carries prepared message overrides forward to
   * subsequent steps.
   *
   * writeAssistantSegment persists the matching
   * `[assistant, reminder, assistant]` split so later requests reproduce the
   * exact prompt prefix the model saw.
   */
  public createPrepareStep<
    TOOLS extends Record<string, Tool> = Record<string, Tool>,
  >(
    options: {
      steer?: boolean;
      additionalInput?: PrepareStepInputProvider;
    } = {},
  ): PrepareStepFunction<TOOLS> {
    const enableSteer = options.steer ?? true;
    const session: ReminderSession = {
      firedOnceIds: new Set(),
      fired: [],
      currentSegStart: 0,
      materialized: 0,
    };
    this.#currentReminderSession = session;
    // Guardrail retries reuse this hook while AI SDK step numbers restart at
    // zero. Translate each retry-local number into the cumulative UI message's
    // step coordinates so persisted reminder boundaries remain exact.
    let stepOffset = 0;
    let previousStepNumber: number | undefined;

    return async ({ steps, stepNumber, messages }) => {
      if (
        previousStepNumber !== undefined &&
        stepNumber <= previousStepNumber
      ) {
        stepOffset += previousStepNumber + 1;
      }
      previousStepNumber = stepNumber;
      const cumulativeStepNumber = stepOffset + stepNumber;

      // Steer is mid-loop only: never fire before the model has produced a step
      // with content, so its synthetic user is preceded by an assistant turn.
      const priorStep = stepNumber >= 1 ? steps[stepNumber - 1] : undefined;
      const hasSafeBoundary = (priorStep?.content?.length ?? 0) > 0;
      const canFire = enableSteer && hasSafeBoundary;
      const steerConfigs = canFire ? this.#remindersFor('steer') : [];
      const outcomes = toolOutcomesFromStep(steps.at(-1)?.content ?? []);

      // One chain read per boundary, shared by both targets. It must be read
      // HERE — not cached across the stream — so both see the segments the
      // model produced earlier in this same turn.
      const needsChain =
        steerConfigs.length > 0 ||
        (outcomes.length > 0 && this.#remindersFor('tool-output').length > 0);
      const chain = needsChain ? await this.#getChainContext() : undefined;

      const toolReminders = chain
        ? await this.#evaluateToolOutputReminders(outcomes, session, chain)
        : { texts: [], onceIds: [] };
      // Host input is valid before any sampling request, including the first
      // request of an approval continuation. Steer reminders remain mid-loop
      // only because they require a completed assistant step.
      const additionalInput = await options.additionalInput?.();
      let reminderInput: (UIMessage & { role: 'user' }) | undefined;

      if (canFire && chain) {
        const configs = steerConfigs;
        if (configs.length > 0) {
          const whenCtx = this.#steerWhenCtx(chain, session);
          const matched = await evaluateFiredReminders(configs, whenCtx);
          if (matched.length > 0) {
            const onceIds = [
              ...new Set([
                ...toolReminders.onceIds,
                ...matched.flatMap((m) => m.onceIds),
              ]),
            ];
            for (const id of onceIds) session.firedOnceIds.add(id);
            reminderInput = synthesizeReminderMessage(
              [
                ...(toolReminders.texts.length > 0
                  ? [toolReminders.texts.join('\n')]
                  : []),
                ...matched.map((m) => m.resolved.text),
              ],
              Date.now(),
              onceIds,
            );
          }
        }
      }

      if (!reminderInput && toolReminders.texts.length > 0) {
        reminderInput = synthesizeReminderMessage(
          toolReminders.texts.join('\n'),
          Date.now(),
          toolReminders.onceIds,
        );
      }

      const inputs = [
        ...(additionalInput ?? []),
        ...(reminderInput ? [reminderInput] : []),
      ];
      if (inputs.length > 0) {
        const inputModel = await convertToModelMessages(inputs as never, {
          ignoreIncompleteToolCalls: true,
        });
        session.fired.push({
          afterStep: cumulativeStepNumber - 1,
          messages: inputs,
        });
        return {
          messages: [...(messages as ModelMessage[]), ...inputModel],
        };
      }

      return undefined;
    };
  }

  /**
   * Persist the streamed assistant message, carving it at reminder boundaries.
   *
   * Called from chat()'s onStepEnd/onEnd (and the guardrail path) with the
   * cumulative response message. Segment boundaries come from the `step-start`
   * markers in the message itself — no cross-track store read — so the carve is
   * race-free. Idempotent: finalized segments keep stable ids; the open segment
   * is updated in place. With no fired reminder it degrades to a plain in-place
   * write of the whole message to the reserved head.
   */
  public async writeAssistantSegment(
    message: UIMessage,
    options: {
      /** Materialize reminders sent without a following step marker. */
      final?: boolean;
    } = {},
  ): Promise<void> {
    const head = await this.headMessage();
    if (head?.name !== 'assistant') {
      throw new Error(
        'writeAssistantSegment: expected an assistant message at chain head.',
      );
    }

    const session = this.#currentReminderSession;
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
      const boundary =
        stepStarts[fire.afterStep + 1] ??
        (options.final ? message.parts.length : undefined);
      if (boundary === undefined) break; // the post-reminder step has not started

      this.set(
        assistant({
          id: session.currentSegId,
          role: 'assistant',
          parts: message.parts.slice(session.currentSegStart, boundary),
        } as UIMessage),
      );
      for (const input of fire.messages) this.set(user(input));
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

  #remindersFor(target: ReminderTarget): ConditionalReminder[] {
    return this.#fragments
      .filter(isConditionalReminder)
      .map((fragment) => fragment.metadata.reminder)
      .filter((config) => config.target === target);
  }

  #buildBaseWhenCtx(chain: ChainSummary): BaseWhenCtx {
    const rawUsage = this.#chatData?.metadata?.usage;
    const usage = isLanguageModelUsage(rawUsage) ? rawUsage : undefined;
    const elapsed =
      chain.lastMessageAt !== undefined
        ? Date.now() - chain.lastMessageAt
        : undefined;
    const chatData = this.#chatData;
    if (!chatData) {
      throw new Error('ContextEngine must be initialized before reminders run');
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
  }

  #buildWhenCtx(chain: ChainSummary, currentMessage: UIMessage): WhenContext {
    return {
      ...this.#buildBaseWhenCtx(chain),
      content: extractPlainText(currentMessage),
      currentMessage,
      lastAssistantMessage: chain.lastAssistantMessage,
      lastAssistantMessages: chain.lastAssistantMessages,
      lastAssistantReplies: chain.lastAssistantReplies,
    };
  }

  /**
   * Mid-loop reminders fire through prepareStep, so save() only folds user-target
   * reminders into the last pending real user message.
   */
  async #foldUserReminders(pending: ContextFragment[]): Promise<void> {
    const configs = this.#remindersFor('user');
    if (configs.length === 0) return;

    const fragmentIndex = pending.findLastIndex((fragment) => {
      if (fragment.name !== 'user') return false;
      const encoded = fragment.codec?.encode();
      return !encoded || !isSyntheticReminderMessage(encoded as UIMessage);
    });
    if (fragmentIndex < 0) return;
    const fragment = pending[fragmentIndex];
    if (!fragment.codec) return;
    const message = requireUserUIMessage(
      fragment.codec.encode(),
      `Pending user fragment "${fragment.name}"`,
    );

    const chain = await this.#getChainContext();
    const matched = await evaluateFiredReminders(configs, {
      ...this.#buildWhenCtx(chain, message),
      firedOnceIds: chain.firedOnceIds,
    });
    if (matched.length === 0) return;

    const onceIds = [...new Set(matched.flatMap((m) => m.onceIds))];
    const reminders = matched.map((m) => ({
      text: m.resolved.text,
      asPart: m.config.asPart,
      metadata: m.resolved.metadata,
    }));
    const carrier: UIMessage & { role: 'user' } = {
      ...message,
      id: fragment.id ?? message.id,
      parts: [...message.parts],
    };
    if (onceIds.length > 0) {
      carrier.metadata = {
        ...(carrier.metadata as Record<string, unknown> | undefined),
        onceIds,
      };
    }
    applyUserRemindersToMessage(carrier, reminders);
    pending[fragmentIndex] = user(carrier);
  }

  /**
   * Steer predicates run against the chain as it stands AT THIS BOUNDARY.
   *
   * writeAssistantSegment persists each assistant segment before the next
   * prepareStep runs, so re-reading the chain is what lets a steer reminder
   * observe the turn as it unfolds. Caching this across the stream froze
   * lastAssistantMessage(s) at the first boundary and made every
   * history-derived steer predicate (toolCallCount, everyOfLastN, a tool first
   * called after step 0) silently blind to the rest of its own turn.
   *
   * `elapsed` still measures from the last real user message: synthetic steer
   * nudges do not advance it (chain-summary excludes them), so a raw
   * elapsedExceeds keeps firing every step once crossed — by design; compose
   * once() for control.
   */
  #steerWhenCtx(chain: ChainSummary, session: ReminderSession): WhenContext {
    const currentMessage = chain.lastMessage;
    if (!currentMessage) {
      throw new Error(
        'steer reminders require a user message earlier in the turn',
      );
    }

    return {
      ...this.#buildWhenCtx(chain, currentMessage),
      firedOnceIds: new Set([...chain.firedOnceIds, ...session.firedOnceIds]),
    };
  }

  async #evaluateToolOutputReminders(
    outcomes: ToolOutcome[],
    session: ReminderSession,
    chain: ChainSummary,
  ): Promise<{ texts: string[]; onceIds: string[] }> {
    const configs = this.#remindersFor('tool-output');
    if (configs.length === 0 || outcomes.length === 0) {
      return { texts: [], onceIds: [] };
    }

    const currentMessage = chain.lastMessage;
    if (!currentMessage) return { texts: [], onceIds: [] };

    const texts: string[] = [];
    const onceIds = new Set<string>();
    for (const outcome of outcomes) {
      const whenCtx = this.#buildWhenCtx(chain, currentMessage);
      whenCtx.toolOutcome = outcome;
      whenCtx.firedOnceIds = new Set([
        ...chain.firedOnceIds,
        ...session.firedOnceIds,
      ]);
      const matched = await evaluateFiredReminders(configs, whenCtx);
      texts.push(...matched.map((item) => item.resolved.text));
      for (const id of matched.flatMap((item) => item.onceIds)) {
        onceIds.add(id);
        session.firedOnceIds.add(id);
      }
    }
    return { texts, onceIds: [...onceIds] };
  }

  #asSavePipelineEngine() {
    return {
      store: this.#store,
      chatId: this.#chatId,
      getActiveBranch: () => ({
        id: this.#activeBranch.id,
        headMessageId: this.#activeBranch.headMessageId,
      }),
      commitHead: async (
        headMessageId: string,
        expectedHeadMessageId: string | null,
      ) => {
        const committed = await this.#store.updateBranchHead(
          this.#activeBranch.id,
          headMessageId,
          expectedHeadMessageId,
        );
        if (committed) {
          this.#activeBranch.headMessageId = headMessageId;
        }
        return committed;
      },
      refreshBranch: async () => {
        const fresh = await this.#store.getBranch(
          this.#chatId,
          this.#activeBranch.name,
        );
        if (!fresh) {
          throw new Error(
            `Branch "${this.#activeBranch.name}" not found for chat "${this.#chatId}"`,
          );
        }
        this.#branch = fresh;
        return { id: fresh.id, headMessageId: fresh.headMessageId };
      },
      rewindForUpdate: (parentId: string) => this.#rewindForUpdate(parentId),
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
   * context.set(
   *   user({
   *     id: 'q1',
   *     role: 'user',
   *     parts: [{ type: 'text', text: 'What is 2 + 2?' }],
   *   }),
   * );
   * context.set(assistantText('The answer is 5.', { id: 'wrong' })); // Oops!
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

    this.#chatData = await this.#store.updateChat(
      this.#chatId,
      ({ metadata }) => ({
        title: updates.title,
        metadata:
          updates.metadata === undefined
            ? undefined
            : { ...metadata, ...updates.metadata },
      }),
    );
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
   * const usage = await result.usage;
   * await context.trackUsage(usage);
   * ```
   */
  public async trackUsage(usage: LanguageModelUsage): Promise<void> {
    await this.#ensureInitialized();

    this.#chatData = await this.#store.updateChat(
      this.#chatId,
      ({ metadata }) => {
        const storedUsage = metadata?.usage;
        const currentUsage = isLanguageModelUsage(storedUsage)
          ? storedUsage
          : undefined;
        return {
          metadata: {
            ...metadata,
            usage: mergeLanguageModelUsage(currentUsage, usage),
          },
        };
      },
    );
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
   * and resolver chain, but a fresh in-memory store and no message history.
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
      resolvers: this.#resolvers,
    });
    child.set(...this.#fragments);
    return child;
  }

  /** Return the explicit skills from the first available_skills fragment. */
  public getAvailableSkills(): AvailableSkill[] {
    for (const fragment of this.#fragments) {
      const skills = fragment.metadata?.skills;
      if (
        fragment.name === 'available_skills' &&
        Array.isArray(skills) &&
        skills.every(isAvailableSkill)
      ) {
        return skills.map(({ name, description, path }) => ({
          name,
          description,
          path,
        }));
      }
    }
    return [];
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
