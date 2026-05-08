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
}

export type WhenPredicate = (ctx: WhenContext) => boolean | Promise<boolean>;

export type ReminderTarget = 'user' | 'tool-output';

export interface UserReminderOptions {
  asPart?: boolean;
  target?: 'user';
}

export interface UserReminder {
  text: SyncReminderText;
  asPart: boolean;
  target: 'user';
  metadata?: Record<string, unknown>;
}

export interface ConditionalReminderOptions {
  when: WhenPredicate;
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
  mode: 'inline' | 'part' | 'tool-output';
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

function reminderTargetOf(record: ReminderMetadataRecord): ReminderTarget {
  return record.target === 'tool-output' ? 'tool-output' : 'user';
}

function normalizeReminderTarget(target: unknown): ReminderTarget {
  if (target === undefined || target === 'user') return 'user';
  if (target === 'tool-output') return 'tool-output';
  throw new Error(`Unsupported reminder target: ${String(target)}`);
}

function isConditionalReminderOptions(
  options: UserReminderOptions | ConditionalReminderOptions | undefined,
): options is ConditionalReminderOptions {
  return options !== undefined && 'when' in options;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function normalizeImmediateReminderText(
  textOrFragment: ReminderText | ContextFragment,
): SyncReminderText {
  if (isFragment(textOrFragment)) {
    return new XmlRenderer().render([textOrFragment]);
  }

  if (typeof textOrFragment === 'string') {
    return textOrFragment;
  }

  return (ctx) => {
    const resolved = textOrFragment(ctx);
    if (isPromiseLike(resolved)) {
      throw new Error('Async reminder text requires a when predicate');
    }
    return resolved;
  };
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
  return isRecord(value) && typeof value.systemReminder === 'string';
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
  const reminderRecords = getReminderMetadataRecords(
    isRecord(message.metadata) ? message.metadata : undefined,
  );
  const rangesByPartIndex = new Map<
    number,
    Array<{ start: number; end: number }>
  >();
  const toolRemindersByPartIndex = new Map<number, ReminderMetadataRecord[]>();

  for (const range of reminderRecords) {
    if (reminderTargetOf(range) === 'tool-output') {
      const records = toolRemindersByPartIndex.get(range.partIndex) ?? [];
      records.push(range);
      toolRemindersByPartIndex.set(range.partIndex, records);
      continue;
    }

    const partRanges = rangesByPartIndex.get(range.partIndex) ?? [];
    partRanges.push({ start: range.start, end: range.end });
    rangesByPartIndex.set(range.partIndex, partRanges);
  }

  const strippedParts = message.parts.flatMap((part, partIndex) => {
    const clonedPart = { ...part };
    const toolReminderRecords = toolRemindersByPartIndex.get(partIndex);

    if (
      toolReminderRecords !== undefined &&
      isOutputAvailableToolPart(clonedPart)
    ) {
      if (typeof clonedPart.output === 'string') {
        return [
          {
            ...clonedPart,
            output: stripTextByRanges(
              clonedPart.output,
              toolReminderRecords.map((record) => ({
                start: record.start,
                end: record.end,
              })),
            ),
          },
        ];
      }

      if (isToolOutputReminderEnvelope(clonedPart.output)) {
        return [{ ...clonedPart, output: clonedPart.output.result }];
      }
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
  const part: UIMessage['parts'][number] = { type: 'text', text: value };
  message.parts.push(part);
  const partIndex = message.parts.length - 1;

  return {
    id: generateId(),
    text: value,
    target: 'user',
    partIndex,
    start: 0,
    end: value.length,
    mode: 'part',
  };
}

export function resolveReminderText(
  item: { text: SyncReminderText },
  ctx: ReminderContext,
): string {
  return resolveReminder(item, ctx)?.text ?? '';
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

export function findSingleOutputAvailableToolPart(
  message: UIMessage,
): { partIndex: number; part: OutputAvailableToolPart } | null {
  let match: { partIndex: number; part: OutputAvailableToolPart } | null = null;

  for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
    const part = message.parts[partIndex];
    if (!isOutputAvailableToolPart(part)) continue;
    if (match) return null;
    match = { partIndex, part };
  }

  return match;
}

export function applyToolOutputRemindersToMessage(
  message: UIMessage,
  reminders: Array<{ text: string; metadata?: Record<string, unknown> }>,
): UserReminderMetadata[] {
  if (reminders.length === 0) return [];

  const target = findSingleOutputAvailableToolPart(message);
  if (!target) return [];

  for (const reminder of reminders) {
    if (reminder.metadata) {
      mergeMessageMetadata(message, reminder.metadata);
    }
  }

  const added: UserReminderMetadata[] = [];
  if (typeof target.part.output === 'string') {
    let output = target.part.output;

    for (const reminder of reminders) {
      const reminderText = formatTaggedReminder(reminder.text);
      const start = output.length;
      output = `${output}${reminderText}`;
      added.push({
        id: generateId(),
        text: reminder.text,
        target: 'tool-output',
        partIndex: target.partIndex,
        start,
        end: start + reminderText.length,
        mode: 'tool-output',
      });
    }

    message.parts[target.partIndex] = {
      ...target.part,
      output,
    };
    return added;
  }

  message.parts[target.partIndex] = {
    ...target.part,
    output: {
      result: target.part.output,
      systemReminder: reminders.map((reminder) => reminder.text).join('\n'),
    },
  };

  return reminders.map((reminder) => ({
    id: generateId(),
    text: reminder.text,
    target: 'tool-output',
    partIndex: target.partIndex,
    start: 0,
    end: 0,
    mode: 'tool-output',
  }));
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
 * Create an immediate reminder for use inside `user()`.
 *
 * Injects reminder text inline as `<system-reminder>...</system-reminder>`.
 *
 * @param text - Reminder text (must not be empty)
 * @param options - Reminder representation options
 */
export function reminder(
  text: SyncReminderText,
  options?: UserReminderOptions,
): UserReminder;
/**
 * Create a conditional reminder fragment for use with `engine.set()`.
 *
 * Evaluated at `save()` time against the current turn context.
 * Only included in the last user message when the predicate returns true.
 *
 * @param text - Reminder text (must not be empty). Can be async.
 * @param options - Must include a `when` predicate
 *
 * @example
 * ```ts
 * engine.set(
 *   reminder('Keep responses concise', { when: everyNTurns(3) }),
 *   user('Hello'),
 * );
 * ```
 */
export function reminder(
  text: ReminderText,
  options: ConditionalReminderOptions,
): ContextFragment;
/**
 * Create an immediate reminder from a context fragment.
 *
 * The fragment is pre-rendered to XML and injected as reminder text.
 * Defaults to inline reminder text.
 *
 * @param fragment - A context fragment to render as reminder text
 * @param options - Reminder representation options
 *
 * @example
 * ```ts
 * context.set(
 *   user('hello', reminder(workflow({ task: 'Error recovery', steps: ['Check logs'] }))),
 * );
 * ```
 */
export function reminder(
  fragment: ContextFragment,
  options?: UserReminderOptions,
): UserReminder;
/**
 * Create a conditional reminder from a context fragment.
 *
 * The fragment is pre-rendered to XML and injected as reminder text
 * when the predicate fires. Defaults to inline reminder text.
 *
 * @param fragment - A context fragment to render as reminder text
 * @param options - Must include a `when` predicate
 *
 * @example
 * ```ts
 * engine.set(
 *   reminder(
 *     workflow({ task: 'Error recovery', steps: ['Check logs', 'Fix query'] }),
 *     { when: contentIncludes(['error', 'fail']) },
 *   ),
 *   user('my query failed'),
 * );
 * ```
 */
export function reminder(
  fragment: ContextFragment,
  options: ConditionalReminderOptions,
): ContextFragment;
export function reminder(
  textOrFragment: ReminderText | ContextFragment,
  options?: UserReminderOptions | ConditionalReminderOptions,
): UserReminder | ContextFragment {
  const target = normalizeReminderTarget(options?.target);
  const asPart = target === 'user' ? (options?.asPart ?? false) : false;

  if (isConditionalReminderOptions(options)) {
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
          when: options.when,
          asPart,
          target,
        } satisfies ConditionalReminder,
      },
    };
  }

  if (target !== 'user') {
    throw new Error('Reminder target "tool-output" requires a when predicate');
  }

  const text = normalizeImmediateReminderText(textOrFragment);
  if (typeof text === 'string') {
    assertReminderText(text);
  }

  return {
    text,
    asPart,
    target,
  };
}

/**
 * Create a user message fragment.
 * Message fragments are separated from regular fragments during resolve().
 *
 * Reminders are baked into the message at creation time as
 * `<system-reminder>...</system-reminder>` tags.
 *
 * For conditional reminders that fire based on turn count, use
 * `reminder(text, { when })` directly with `engine.set()` instead.
 *
 * @param content - The message content
 * @param reminders - Optional hidden/system reminders
 *
 * @example
 * ```ts
 * context.set(user('Hello')); // Plain user message
 * context.set(
 *   user('Deploy this', reminder('Ask for confirmation before destructive actions')),
 * );
 * ```
 */
export function user(
  content: string | (UIMessage & { role: 'user' }),
  ...reminders: UserReminder[]
): MessageFragment {
  const message: UIMessage =
    typeof content === 'string'
      ? {
          id: generateId(),
          role: 'user',
          parts: [{ type: 'text', text: content }],
        }
      : { ...content, role: 'user', parts: [...content.parts] };

  if (reminders.length > 0) {
    const plainText = extractPlainText(message);
    const added: UserReminderMetadata[] = [];
    for (const item of reminders) {
      const meta = applyReminderToMessage(message, item, {
        content: plainText,
      });
      if (meta) added.push(meta);
    }
    mergeReminderMetadata(message, added);
  }

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
