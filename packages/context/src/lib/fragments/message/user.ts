import {
  type LanguageModelUsage,
  type ToolUIPart,
  type UIMessage,
  generateId,
  isStaticToolUIPart,
} from 'ai';

import {
  type ContextFragment,
  type MessageFragment,
  isFragment,
} from '../../fragments.ts';
import { XmlRenderer } from '../../renderers/abstract.renderer.ts';
import type { StoredChatData } from '../../store/store.ts';
import { extractPlainText } from '../../text.ts';

export interface ReminderContext {
  content: string;
  turn?: number;
  lastMessageAt?: number;
  lastMessage?: UIMessage;
  currentMessage?: UIMessage;
  chat?: StoredChatData;
  usage?: LanguageModelUsage;
  branch?: string;
  elapsed?: number;
  messageCount?: number;
  lastAssistantMessage?: UIMessage;
}

export interface ReminderResolution {
  text: string;
  metadata?: Record<string, unknown>;
}

export type SyncReminderText =
  | string
  | ((ctx: ReminderContext) => string | ReminderResolution);

export type ReminderText =
  | string
  | ((
      ctx: ReminderContext,
    ) => string | ReminderResolution | Promise<string | ReminderResolution>);

export interface WhenContext {
  turn: number;
  content: string;
  lastMessageAt?: number;
  lastMessage?: UIMessage;
  currentMessage: UIMessage;
  chat: StoredChatData;
  usage?: LanguageModelUsage;
  branch: string;
  elapsed?: number;
  messageCount: number;
  lastAssistantMessage?: UIMessage;
  lastAssistantMessages?: UIMessage[];
  /**
   * Ids that a fire-once latch has already fired for in this conversation
   * (persisted synth onceIds ∪ this stream's fires). Populated only during
   * steer evaluation; `once(id)` reads it to suppress a second fire.
   */
  firedOnceIds?: ReadonlySet<string>;
  /**
   * Per-evaluation buffer that `once(id)` appends to when consulted and not yet
   * fired. The engine commits these ids — to the session and the synth — only
   * if the whole reminder fires. One fresh collector per config evaluation.
   */
  onceCollector?: Set<string>;
}

/**
 * The engine-level slice of `WhenContext` — everything that does not depend on a
 * specific carrier message. Callers add `content`/`currentMessage`/the
 * last-assistant fields once they have located the message being evaluated.
 */
export type BaseWhenCtx = Omit<
  WhenContext,
  | 'content'
  | 'currentMessage'
  | 'lastAssistantMessage'
  | 'lastAssistantMessages'
>;

export type WhenPredicate = (ctx: WhenContext) => boolean | Promise<boolean>;

export type ReminderTarget = 'user' | 'tool-output' | 'steer';

export interface SyntheticSteerMetadata {
  source: 'steer-reminder';
  firedAt: number;
  onceIds?: string[];
}

export interface ReminderOptions {
  /**
   * Predicate gating when the reminder fires. Optional for `target: 'user'`
   * (omit ⇒ always fires; pair with `once(id)` for one-time); required for
   * `steer` / `tool-output`, where a trigger-less reminder is meaningless.
   */
  when?: WhenPredicate;
  asPart?: boolean;
  target?: ReminderTarget;
}

export interface ConditionalReminder {
  text: ReminderText;
  when: WhenPredicate;
  asPart: boolean;
  target: ReminderTarget;
}

export function isConditionalReminder(
  fragment: ContextFragment,
): fragment is ContextFragment & {
  metadata: { reminder: ConditionalReminder };
} {
  return fragment.name === 'reminder' && !!fragment.metadata?.reminder;
}

export interface UserReminderMetadata {
  id: string;
  text: string;
  target: ReminderTarget;
  partIndex: number;
  start: number;
  end: number;
  mode: 'inline' | 'part';
}

export type ReminderRange = {
  partIndex: number;
  start: number;
  end: number;
};

const SYSTEM_REMINDER_OPEN_TAG = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE_TAG = '</system-reminder>';

type ReminderMetadataRecord = ReminderRange & {
  target?: unknown;
  mode?: unknown;
};

type OutputAvailableToolPart = ToolUIPart & {
  state: 'output-available';
  output: unknown;
};

export function getReminderRanges(
  metadata: Record<string, unknown> | undefined,
): ReminderRange[] {
  return getReminderMetadataRecords(metadata).map((record) => ({
    partIndex: record.partIndex,
    start: record.start,
    end: record.end,
  }));
}

/**
 * Once-ids latched by `once()`-gated reminders folded into this user message.
 * Persisted so a fresh engine re-reads them (the durable suppression record for
 * user-target `once()`, mirroring synthetic steer messages).
 */
export function getReminderOnceIds(message: UIMessage): string[] {
  const meta = message.metadata;
  if (!isRecord(meta) || !Array.isArray(meta.onceIds)) return [];
  return meta.onceIds.filter((id): id is string => typeof id === 'string');
}

function getReminderMetadataRecords(
  metadata: Record<string, unknown> | undefined,
): ReminderMetadataRecord[] {
  const reminders = metadata?.reminders;
  if (!Array.isArray(reminders)) return [];
  return reminders.filter(
    (item): item is ReminderMetadataRecord =>
      isRecord(item) &&
      typeof item.partIndex === 'number' &&
      typeof item.start === 'number' &&
      typeof item.end === 'number',
  );
}

function normalizeReminderTarget(target: unknown): ReminderTarget {
  if (target === undefined || target === 'user') return 'user';
  if (target === 'tool-output') return 'tool-output';
  if (target === 'steer') return 'steer';
  throw new Error(`Unsupported reminder target: ${String(target)}`);
}

function normalizeConditionalReminderText(
  textOrFragment: ReminderText | ContextFragment,
): ReminderText {
  return isFragment(textOrFragment)
    ? new XmlRenderer().render([textOrFragment])
    : textOrFragment;
}

function isOutputAvailableToolPart(
  part: UIMessage['parts'][number],
): part is OutputAvailableToolPart {
  return isStaticToolUIPart(part) && part.state === 'output-available';
}

function isToolOutputReminderEnvelope(
  value: unknown,
): value is { result: unknown; systemReminder: string } {
  // Detect via the host-only `meta` marker, not the reminder tag text, so
  // detection survives a future change to the tag format. A real tool output
  // never sets meta.reminder, so there are no false positives.
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    value.meta.reminder === true &&
    'result' in value &&
    typeof value.systemReminder === 'string'
  );
}

export function stripTextByRanges(
  text: string,
  ranges: Array<{ start: number; end: number }>,
): string {
  if (ranges.length === 0) {
    return text;
  }

  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, range.start)),
      end: Math.max(0, Math.min(text.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  if (normalized.length === 0) {
    return text;
  }

  let cursor = 0;
  let output = '';

  for (const range of normalized) {
    if (range.start < cursor) {
      if (range.end > cursor) {
        cursor = range.end;
      }
      continue;
    }

    output += text.slice(cursor, range.start);
    cursor = range.end;
  }

  output += text.slice(cursor);
  return output.trimEnd();
}

/**
 * Strip reminder content from a message using reminder metadata ranges.
 *
 * - Inline reminders are removed from text parts.
 * - Part reminders are removed as whole parts when their full text is stripped.
 * - `metadata.reminders` is removed from the returned message.
 */
export function stripReminders(message: UIMessage): UIMessage {
  if (isSyntheticSteerMessage(message)) {
    return stripSyntheticSteerMessage(message);
  }

  const reminderRecords = getReminderMetadataRecords(
    isRecord(message.metadata) ? message.metadata : undefined,
  );
  const rangesByPartIndex = new Map<
    number,
    Array<{ start: number; end: number }>
  >();

  for (const range of reminderRecords) {
    const partRanges = rangesByPartIndex.get(range.partIndex) ?? [];
    partRanges.push({ start: range.start, end: range.end });
    rangesByPartIndex.set(range.partIndex, partRanges);
  }

  const strippedParts = message.parts.flatMap((part, partIndex) => {
    const clonedPart = { ...part };

    if (
      isOutputAvailableToolPart(clonedPart) &&
      isToolOutputReminderEnvelope(clonedPart.output)
    ) {
      return [{ ...clonedPart, output: clonedPart.output.result }];
    }

    const ranges = rangesByPartIndex.get(partIndex);

    if (clonedPart.type !== 'text' || ranges === undefined) {
      return [clonedPart];
    }

    const strippedText = stripTextByRanges(clonedPart.text, ranges);
    if (strippedText.length === 0) {
      return [];
    }

    return [{ ...clonedPart, text: strippedText }];
  });

  const nextMessage: UIMessage = {
    ...message,
    parts: strippedParts,
  };

  if (isRecord(message.metadata)) {
    const metadata = { ...message.metadata };
    delete metadata.reminders;

    if (Object.keys(metadata).length > 0) {
      nextMessage.metadata = metadata;
    } else {
      delete nextMessage.metadata;
    }
  }

  return nextMessage;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertReminderText(text: string) {
  if (text.trim().length === 0) {
    throw new Error('Reminder text must not be empty');
  }
}

function formatTaggedReminder(text: string): string {
  return `${SYSTEM_REMINDER_OPEN_TAG}${text}${SYSTEM_REMINDER_CLOSE_TAG}`;
}

function findLastTextPartIndex(message: UIMessage): number | undefined {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    if (message.parts[i].type === 'text') {
      return i;
    }
  }

  return undefined;
}

function ensureTextPart(message: UIMessage): number {
  const existingIndex = findLastTextPartIndex(message);
  if (existingIndex !== undefined) {
    return existingIndex;
  }

  const reminderPart: UIMessage['parts'][number] = {
    type: 'text',
    text: '',
  };
  message.parts.push(reminderPart);
  return message.parts.length - 1;
}

export function applyInlineReminder(
  message: UIMessage,
  value: string,
): UserReminderMetadata {
  const partIndex = ensureTextPart(message);
  const textPart = message.parts[partIndex];
  if (textPart.type !== 'text') {
    throw new Error('Failed to resolve text part for inline reminder');
  }

  const reminderText = formatTaggedReminder(value);
  const start = textPart.text.length;
  const updatedText = `${textPart.text}${reminderText}`;
  message.parts[partIndex] = { ...textPart, text: updatedText };

  return {
    id: generateId(),
    text: value,
    target: 'user',
    partIndex,
    start,
    end: start + reminderText.length,
    mode: 'inline',
  };
}

export function applyPartReminder(
  message: UIMessage,
  value: string,
): UserReminderMetadata {
  const reminderText = formatTaggedReminder(value);
  const part: UIMessage['parts'][number] = { type: 'text', text: reminderText };
  message.parts.push(part);
  const partIndex = message.parts.length - 1;

  return {
    id: generateId(),
    text: value,
    target: 'user',
    partIndex,
    start: 0,
    end: reminderText.length,
    mode: 'part',
  };
}

function normalizeReminderResolution(
  value: string | ReminderResolution,
): ReminderResolution | null {
  if (typeof value === 'string') {
    return value.trim().length === 0 ? null : { text: value };
  }

  if (value.text.trim().length === 0) {
    return null;
  }

  return value;
}

export function resolveReminder(
  item: { text: SyncReminderText; metadata?: Record<string, unknown> },
  ctx: ReminderContext,
): ReminderResolution | null {
  const resolvedText =
    typeof item.text === 'function' ? item.text(ctx) : item.text;
  const resolved = normalizeReminderResolution(resolvedText);
  if (!resolved) {
    return null;
  }

  const metadata =
    item.metadata || resolved.metadata
      ? {
          ...(item.metadata ?? {}),
          ...(resolved.metadata ?? {}),
        }
      : undefined;

  return metadata ? { ...resolved, metadata } : resolved;
}

export async function resolveReminderAsync(
  item: { text: ReminderText; metadata?: Record<string, unknown> },
  ctx: ReminderContext,
): Promise<ReminderResolution | null> {
  const text = await (typeof item.text === 'function'
    ? item.text(ctx)
    : item.text);
  const resolved = normalizeReminderResolution(text);
  if (!resolved) return null;

  const metadata =
    item.metadata || resolved.metadata
      ? { ...(item.metadata ?? {}), ...(resolved.metadata ?? {}) }
      : undefined;

  return metadata ? { ...resolved, metadata } : resolved;
}

export function mergeMessageMetadata(
  message: UIMessage,
  addedMetadata: Record<string, unknown>,
): void {
  if (Object.keys(addedMetadata).length === 0) {
    return;
  }

  const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
  message.metadata = { ...metadata, ...addedMetadata };
}

export function applyReminderToMessage(
  message: UIMessage,
  item: {
    text: SyncReminderText;
    asPart: boolean;
    metadata?: Record<string, unknown>;
  },
  ctx: ReminderContext,
): UserReminderMetadata | null {
  const resolved = resolveReminder(item, ctx);
  if (!resolved) {
    return null;
  }
  if (resolved.metadata) {
    mergeMessageMetadata(message, resolved.metadata);
  }
  return item.asPart
    ? applyPartReminder(message, resolved.text)
    : applyInlineReminder(message, resolved.text);
}

/**
 * Wrap a tool's raw `execute()` result with fired reminder texts.
 *
 * Applied at the tool-execution boundary — before the AI SDK hands the result
 * back to the model — so the wrapped value flows identically into the next
 * model step and the persisted chain. The envelope shape is uniform regardless
 * of the output type, which lets `stripReminders` undo it structurally without
 * metadata bookkeeping.
 */
export function applyRemindersToToolOutput(
  output: unknown,
  texts: string[],
): unknown {
  if (texts.length === 0) return output;
  return {
    result: output === undefined ? null : output,
    systemReminder: formatTaggedReminder(texts.join('\n')),
    meta: { reminder: true },
  };
}

/**
 * Project a tool-output reminder envelope to its model-facing form: run the
 * wrapped tool's own projection over the inner `result` (so a tool's host-only
 * `meta` channel is still stripped), then re-attach the `systemReminder`. The
 * envelope's own host-only `meta` marker is dropped. Returns null for anything
 * that is not one of our envelopes, so the caller can project the raw output.
 */
export function toToolReminderModelOutput(
  output: unknown,
  projectResult: (result: unknown) => unknown,
): { type: 'json'; value: unknown } | null {
  if (!isToolOutputReminderEnvelope(output)) return null;
  const projected = projectResult(output.result);
  return {
    type: 'json',
    value: {
      result: isRecord(projected) ? projected.value : projected,
      systemReminder: output.systemReminder,
    },
  };
}

export function mergeReminderMetadata(
  message: UIMessage,
  addedReminders: UserReminderMetadata[],
): void {
  if (addedReminders.length === 0) return;
  const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
  const existing = Array.isArray(metadata.reminders) ? metadata.reminders : [];
  metadata.reminders = [...existing, ...addedReminders];
  message.metadata = metadata;
}

/**
 * Create a reminder fragment, set on the engine via `engine.set()`. The engine
 * folds it into the model's view when its `when` fires: `user` reminders bake a
 * `<system-reminder>` into the last user message at save; `steer` injects mid-
 * loop; `tool-output` wraps the tool result. Text may be a string, a `(ctx) =>
 * string` factory (self-gates by returning `''`), or a context fragment.
 *
 * For `target: 'user'`, `when` is optional — omit it for an always-on
 * instruction, or pass `once(id)` for a one-time reminder. `steer` and
 * `tool-output` require a `when` trigger.
 *
 * @example
 * ```ts
 * engine.set(reminder('Keep responses concise'));                // user, always
 * engine.set(reminder('Welcome!', { when: once('welcome') }));   // user, one-time
 * engine.set(reminder('RECAP', { when: everyNTurns(3), target: 'steer' }));
 * ```
 */
export function reminder(
  textOrFragment: ReminderText | ContextFragment,
  options?: ReminderOptions,
): ContextFragment {
  const target = normalizeReminderTarget(options?.target);
  const asPart = target === 'user' ? (options?.asPart ?? false) : false;

  if (options?.when === undefined && target !== 'user') {
    throw new Error(`Reminder target "${target}" requires a when predicate`);
  }

  const text = normalizeConditionalReminderText(textOrFragment);
  if (typeof text === 'string') {
    assertReminderText(text);
  }

  return {
    name: 'reminder',
    data: null,
    metadata: {
      reminder: {
        text,
        when: options?.when ?? (() => true),
        asPart,
        target,
      } satisfies ConditionalReminder,
    },
  };
}

/**
 * Create a user message fragment. Message fragments are separated from regular
 * fragments during resolve(). Reminders are NOT attached here — declare them
 * with `reminder(..., { target: 'user' })` and `engine.set()`; the engine folds
 * them into the last user message at save time.
 */
export function user(
  content: string | (UIMessage & { role: 'user' }),
): MessageFragment {
  const message: UIMessage =
    typeof content === 'string'
      ? {
          id: generateId(),
          role: 'user',
          parts: [{ type: 'text', text: content }],
        }
      : { ...content, role: 'user', parts: [...content.parts] };

  return {
    id: message.id,
    name: 'user',
    type: 'message',
    persist: true,
    codec: {
      decode() {
        return message;
      },
      encode() {
        return message;
      },
    },
  };
}

/**
 * Bake resolved user reminders into a message in place: append each as a
 * `<system-reminder>` (inline or as its own part) and record the ranges in
 * `metadata.reminders` so `stripReminders` can reverse it. The save fold is the
 * only caller — user reminders are declared on the engine, not on `user()`.
 */
export function applyUserRemindersToMessage(
  message: UIMessage,
  reminders: Array<{
    text: SyncReminderText;
    asPart: boolean;
    metadata?: Record<string, unknown>;
  }>,
): void {
  if (reminders.length === 0) return;
  const plainText = extractPlainText(message);
  const added: UserReminderMetadata[] = [];
  for (const item of reminders) {
    const meta = applyReminderToMessage(message, item, { content: plainText });
    if (meta) added.push(meta);
  }
  mergeReminderMetadata(message, added);
}

/**
 * Build the hidden synthetic user message injected mid-loop for steer reminders.
 *
 * Multiple reminder texts that fire at the same step boundary are folded into a
 * single user message (one `<system-reminder>` text part each) so the model
 * never sees two consecutive user messages — which providers like Anthropic
 * reject. The `metadata.synthetic` marker lets the chain summary, title
 * generation, and `stripReminders` treat these as non-conversational.
 */
export function synthesizeSteerUserMessage(
  text: string | string[],
  firedAt: number,
  onceIds: string[] = [],
): UIMessage & { role: 'user' } {
  const texts = Array.isArray(text) ? text : [text];
  for (const value of texts) assertReminderText(value);
  return {
    id: generateId(),
    role: 'user',
    parts: texts.map((value) => ({
      type: 'text',
      text: formatTaggedReminder(value),
    })),
    metadata: {
      synthetic: {
        source: 'steer-reminder',
        firedAt,
        ...(onceIds.length > 0 ? { onceIds } : {}),
      } satisfies SyntheticSteerMetadata,
    },
  };
}

export function isSyntheticSteerMessage(
  message: UIMessage,
): message is UIMessage & {
  metadata: { synthetic: SyntheticSteerMetadata };
} {
  const meta = message.metadata;
  if (!isRecord(meta)) return false;
  const synthetic = meta.synthetic;
  if (!isRecord(synthetic)) return false;
  return synthetic.source === 'steer-reminder';
}

/**
 * A synthetic steer message is entirely `<system-reminder>` payload, so
 * stripping reminders drops its text parts wholesale and clears the synthetic
 * marker — leaving nothing for title/strip consumers to leak.
 */
function stripSyntheticSteerMessage(message: UIMessage): UIMessage {
  const next: UIMessage = {
    ...message,
    parts: message.parts.filter((part) => part.type !== 'text'),
  };
  if (isRecord(message.metadata)) {
    const metadata = { ...message.metadata };
    delete metadata.synthetic;
    if (Object.keys(metadata).length > 0) {
      next.metadata = metadata;
    } else {
      delete next.metadata;
    }
  }
  return next;
}
