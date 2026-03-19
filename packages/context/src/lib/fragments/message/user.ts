import { type UIMessage, generateId, isTextUIPart } from 'ai';

import type { MessageFragment } from '../../fragments.ts';

export interface ReminderContext {
  content: string;
  turn?: number;
}

export type ReminderText = string | ((ctx: ReminderContext) => string);

export type WhenPredicate = (turn: number) => boolean;

export function everyNTurns(n: number): WhenPredicate {
  return (turn) => turn % n === 0;
}

export function once(): WhenPredicate {
  return (turn) => turn === 1;
}

export function firstN(n: number): WhenPredicate {
  return (turn) => turn <= n;
}

export function afterTurn(n: number): WhenPredicate {
  return (turn) => turn > n;
}

export function and(...predicates: WhenPredicate[]): WhenPredicate {
  return (turn) => predicates.every((p) => p(turn));
}

export function or(...predicates: WhenPredicate[]): WhenPredicate {
  return (turn) => predicates.some((p) => p(turn));
}

export function not(predicate: WhenPredicate): WhenPredicate {
  return (turn) => !predicate(turn);
}

export interface ReminderSchedule {
  when?: WhenPredicate;
}

export interface UserReminderOptions extends ReminderSchedule {
  asPart?: boolean;
}

export interface UserReminder extends ReminderSchedule {
  text: ReminderText;
  asPart: boolean;
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

function extractPlainText(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

export function hasSchedule(reminder: UserReminder): boolean {
  return reminder.when !== undefined;
}

export function shouldIncludeReminder(
  reminder: UserReminder,
  turn: number,
): boolean {
  if (reminder.when && !reminder.when(turn)) return false;
  return true;
}

/**
 * Create a user reminder payload for user message builders.
 *
 * Default behavior injects reminder text inline as
 * `<system-reminder>...</system-reminder>`.
 *
 * @param text - Reminder text (must not be empty)
 * @param options - Reminder representation and scheduling options
 */
export function reminder(
  text: ReminderText,
  options?: UserReminderOptions,
): UserReminder {
  if (typeof text === 'string') {
    assertReminderText(text);
  }
  return {
    text,
    asPart: options?.asPart ?? false,
    ...(options?.when !== undefined && { when: options.when }),
  };
}

export function resolveReminderText(
  item: UserReminder,
  ctx: ReminderContext,
): string {
  return typeof item.text === 'function' ? item.text(ctx) : item.text;
}

/**
 * Create a user message fragment.
 * Message fragments are separated from regular fragments during resolve().
 *
 * Immediate reminders (no schedule) are baked into the message at creation time.
 * Scheduled reminders are stored as fragment metadata and applied by the
 * ContextEngine during resolve() based on the current turn count.
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
 * context.set(
 *   user('Hello', reminder('Keep concise', { when: everyNTurns(3) })),
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

  const immediateReminders = reminders.filter((r) => !hasSchedule(r));
  const scheduledReminders = reminders.filter((r) => hasSchedule(r));

  if (immediateReminders.length > 0) {
    const addedReminders: UserReminderMetadata[] = [];
    const plainText = extractPlainText(message);

    for (const item of immediateReminders) {
      const resolvedText = resolveReminderText(item, { content: plainText });

      if (resolvedText.trim().length === 0) {
        continue;
      }

      addedReminders.push(
        item.asPart
          ? applyPartReminder(message, resolvedText)
          : applyInlineReminder(message, resolvedText),
      );
    }

    if (addedReminders.length > 0) {
      const metadata = isRecord(message.metadata)
        ? { ...message.metadata }
        : {};
      const existingReminders = Array.isArray(metadata.reminders)
        ? metadata.reminders
        : [];
      metadata.reminders = [...existingReminders, ...addedReminders];
      message.metadata = metadata;
    }
  }

  const fragmentMetadata: Record<string, unknown> | undefined =
    scheduledReminders.length > 0 ? { scheduledReminders } : undefined;

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
    metadata: fragmentMetadata,
  };
}
