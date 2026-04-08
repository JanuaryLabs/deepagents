import { type LanguageModelUsage, type UIMessage, generateId } from 'ai';

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
  chat: StoredChatData;
  usage?: LanguageModelUsage;
  branch: string;
  elapsed?: number;
  messageCount: number;
  lastAssistantMessage?: UIMessage;
}

export type WhenPredicate = (ctx: WhenContext) => boolean | Promise<boolean>;

export function everyNTurns(n: number): WhenPredicate {
  return ({ turn }) => turn % n === 0;
}

export function once(): WhenPredicate {
  return ({ turn }) => turn === 1;
}

export function firstN(n: number): WhenPredicate {
  return ({ turn }) => turn <= n;
}

export function afterTurn(n: number): WhenPredicate {
  return ({ turn }) => turn > n;
}

export type AsyncWhenPredicate = (ctx: WhenContext) => Promise<boolean>;

export function and(...predicates: WhenPredicate[]): AsyncWhenPredicate {
  return async (ctx) => {
    for (const it of predicates) {
      if (!(await it(ctx))) return false;
    }
    return true;
  };
}

export function or(...predicates: WhenPredicate[]): AsyncWhenPredicate {
  return async (ctx) => {
    for (const it of predicates) {
      if (await it(ctx)) return true;
    }
    return false;
  };
}

export function not(predicate: WhenPredicate): AsyncWhenPredicate {
  return async (ctx) => !(await predicate(ctx));
}

export function contentIncludes(keywords: string[]): WhenPredicate {
  const lower = keywords.map((k) => k.toLowerCase());
  return (ctx) => {
    const text = ctx.content.toLowerCase();
    return lower.some((kw) => text.includes(kw));
  };
}

export function contentPattern(pattern: RegExp): WhenPredicate {
  return (ctx) => {
    pattern.lastIndex = 0;
    return pattern.test(ctx.content);
  };
}

function toDateParts(
  date: Date,
  tz: string,
): { year: string; month: string; day: string; hour: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
  };
}

function temporalChanged(
  ctx: WhenContext,
  tz: string,
  getKey: (parts: ReturnType<typeof toDateParts>) => string,
): boolean {
  if (ctx.lastMessageAt === undefined) return true;
  const nowParts = toDateParts(new Date(), tz);
  const prevParts = toDateParts(new Date(ctx.lastMessageAt), tz);
  return getKey(nowParts) !== getKey(prevParts);
}

export function getSeason(month: number): string {
  if (month >= 2 && month <= 4) return 'Spring';
  if (month >= 5 && month <= 7) return 'Summer';
  if (month >= 8 && month <= 10) return 'Fall';
  return 'Winter';
}

function isoWeekKey(parts: ReturnType<typeof toDateParts>): string {
  const d = new Date(
    Date.UTC(
      parseInt(parts.year),
      parseInt(parts.month) - 1,
      parseInt(parts.day),
    ),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function dayChanged(tz = 'UTC'): WhenPredicate {
  return (ctx) =>
    temporalChanged(ctx, tz, (p) => `${p.year}-${p.month}-${p.day}`);
}

export function hourChanged(tz = 'UTC'): WhenPredicate {
  return (ctx) =>
    temporalChanged(ctx, tz, (p) => `${p.year}-${p.month}-${p.day}-${p.hour}`);
}

export function monthChanged(tz = 'UTC'): WhenPredicate {
  return (ctx) => temporalChanged(ctx, tz, (p) => `${p.year}-${p.month}`);
}

export function yearChanged(tz = 'UTC'): WhenPredicate {
  return (ctx) => temporalChanged(ctx, tz, (p) => p.year);
}

export function seasonChanged(tz = 'UTC'): WhenPredicate {
  return (ctx) =>
    temporalChanged(ctx, tz, (p) => getSeason(parseInt(p.month) - 1));
}

export function weekChanged(tz = 'UTC'): WhenPredicate {
  return (ctx) => temporalChanged(ctx, tz, isoWeekKey);
}

export interface UserReminderOptions {
  asPart?: boolean;
}

export interface UserReminder {
  text: SyncReminderText;
  asPart: boolean;
  metadata?: Record<string, unknown>;
}

export interface ConditionalReminderOptions {
  when: WhenPredicate;
  asPart?: boolean;
}

export interface ConditionalReminder {
  text: ReminderText;
  when: WhenPredicate;
  asPart: boolean;
}

export function isConditionalReminder(
  fragment: ContextFragment,
): fragment is ContextFragment & {
  metadata: { reminder: ConditionalReminder };
} {
  return fragment.name === 'reminder' && !!fragment.metadata?.reminder;
}

export function getConditionalReminder(
  fragment: ContextFragment,
): ConditionalReminder {
  return fragment.metadata!.reminder as ConditionalReminder;
}

export interface UserReminderMetadata {
  id: string;
  text: string;
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

export function getReminderRanges(
  metadata: Record<string, unknown> | undefined,
): ReminderRange[] {
  return (metadata?.reminders as ReminderRange[] | undefined) ?? [];
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
  const reminderRanges = getReminderRanges(
    isRecord(message.metadata) ? message.metadata : undefined,
  );
  const rangesByPartIndex = new Map<
    number,
    Array<{ start: number; end: number }>
  >();

  for (const range of reminderRanges) {
    const partRanges = rangesByPartIndex.get(range.partIndex) ?? [];
    partRanges.push({ start: range.start, end: range.end });
    rangesByPartIndex.set(range.partIndex, partRanges);
  }

  const strippedParts = message.parts.flatMap((part, partIndex) => {
    const clonedPart = { ...part };
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
      delete (nextMessage as { metadata?: unknown }).metadata;
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

  const reminderPart = {
    type: 'text' as const,
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
  const part = { type: 'text' as const, text: value };
  message.parts.push(part);
  const partIndex = message.parts.length - 1;

  return {
    id: generateId(),
    text: value,
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
 * Defaults to `asPart: true` since fragments produce structured content.
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
 * when the predicate fires. Defaults to `asPart: true`.
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
  const text = isFragment(textOrFragment)
    ? new XmlRenderer().render([textOrFragment])
    : textOrFragment;

  if (typeof text === 'string') {
    assertReminderText(text);
  }

  if (options && 'when' in options && options.when) {
    return {
      name: 'reminder',
      data: null,
      metadata: {
        reminder: {
          text,
          when: options.when,
          asPart: options.asPart ?? false,
        } satisfies ConditionalReminder,
      },
    };
  }

  return {
    text: text as SyncReminderText,
    asPart: options?.asPart ?? false,
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
