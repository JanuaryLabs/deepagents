import { type UIMessage, generateId } from 'ai';

import type { FragmentCodec } from './codec.ts';

/**
 * Fragment type identifier.
 * - 'fragment': Regular context fragment (default)
 * - 'message': Conversation message (user/assistant)
 */
export type FragmentType = 'fragment' | 'message';

/**
 * A context fragment containing a name and associated data.
 */
export interface ContextFragment<T extends FragmentData = FragmentData> {
  /**
   * Unique identifier for this fragment.
   * Auto-generated for user/assistant messages, optional for other fragments.
   */
  id?: string;
  name: string;
  data: T;
  /**
   * Fragment type for categorization.
   * Messages use 'message' type and are handled separately during resolve().
   */
  type?: FragmentType;
  /**
   * When true, this fragment will be persisted to the store on save().
   */
  persist?: boolean;
  /**
   * Codec for encoding/decoding this fragment.
   * Used by resolve() to convert to AI SDK format.
   */
  codec?: FragmentCodec;
  /**
   * Optional metadata for internal tracking.
   * Not rendered to prompt, used for operational purposes like path remapping.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Fragment data can be a primitive, array, object, or nested fragment.
 */
export type FragmentData =
  | string
  | number
  | null
  | undefined
  | boolean
  | ContextFragment
  | FragmentData[]
  | { [key: string]: FragmentData };

export interface UserReminderOptions {
  asPart?: boolean;
}

export interface UserReminder {
  text: string;
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

/**
 * Type guard to check if data is a ContextFragment.
 */
export function isFragment(data: unknown): data is ContextFragment {
  return (
    typeof data === 'object' &&
    data !== null &&
    'name' in data &&
    'data' in data &&
    typeof (data as ContextFragment).name === 'string'
  );
}

/**
 * A plain object with string keys and FragmentData values.
 */
export type FragmentObject = Record<string, FragmentData>;

/**
 * Type guard to check if data is a plain object (not array, not fragment, not primitive).
 */
export function isFragmentObject(data: unknown): data is FragmentObject {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    !isFragment(data)
  );
}

/**
 * Type guard to check if a fragment is a message fragment.
 */
export function isMessageFragment(fragment: ContextFragment): boolean {
  return fragment.type === 'message';
}

export function fragment(
  name: string,
  ...children: FragmentData[]
): ContextFragment {
  return {
    name,
    data: children,
  };
}

const SYSTEM_REMINDER_OPEN_TAG = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE_TAG = '</system-reminder>';

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

function applyInlineReminder(
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

function applyPartReminder(
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

/**
 * Create a user reminder payload for user message builders.
 *
 * Default behavior injects reminder text inline as
 * `<system-reminder>...</system-reminder>`.
 *
 * @param text - Reminder text (must not be empty)
 * @param options - Reminder representation options
 */
export function reminder(
  text: string,
  options?: UserReminderOptions,
): UserReminder {
  assertReminderText(text);
  return {
    text,
    asPart: options?.asPart ?? false,
  };
}

/**
 * Create a user message fragment.
 * Message fragments are separated from regular fragments during resolve().
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
  content: string | UIMessage,
  ...reminders: UserReminder[]
): ContextFragment {
  const message: UIMessage =
    typeof content === 'string'
      ? {
          id: generateId(),
          role: 'user',
          parts: [{ type: 'text', text: content }],
        }
      : { ...content, role: 'user', parts: [...content.parts] };

  if (reminders.length > 0) {
    const addedReminders: UserReminderMetadata[] = [];

    for (const item of reminders) {
      assertReminderText(item.text);

      addedReminders.push(
        item.asPart
          ? applyPartReminder(message, item.text)
          : applyInlineReminder(message, item.text),
      );
    }

    const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
    const existingReminders = Array.isArray(metadata.reminders)
      ? metadata.reminders
      : [];
    metadata.reminders = [...existingReminders, ...addedReminders];
    message.metadata = metadata;
  }

  return {
    id: message.id,
    name: 'user',
    data: 'content',
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
 * Create an assistant message fragment.
 * Message fragments are separated from regular fragments during resolve().
 *
 * @param message - The message content
 * @param options - Optional settings (id)
 *
 * @example
 * ```ts
 * context.set(assistant('Hi there!'));                    // Auto-generated ID
 * context.set(assistant('Hi there!', { id: 'resp-1' })); // Custom ID
 * ```
 */
export function assistant(message: UIMessage): ContextFragment {
  return {
    id: message.id,
    name: 'assistant',
    data: 'content',
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
export function message(content: string | UIMessage): ContextFragment {
  const message =
    typeof content === 'string'
      ? {
          id: generateId(),
          role: 'user' as const,
          parts: [{ type: 'text', text: content }],
        }
      : content;
  return {
    id: message.id,
    name: message.role,
    data: 'content',
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
 * Create an assistant message fragment from text content.
 * Convenience wrapper that creates a UIMessage internally.
 *
 * @param content - The message text content
 * @param options - Optional settings (id)
 *
 * @example
 * ```ts
 * context.set(assistantText('Hi there!'));                    // Auto-generated ID
 * context.set(assistantText('Hi there!', { id: 'resp-1' })); // Custom ID
 * ```
 */
export function assistantText(
  content: string,
  options?: { id?: string },
): ContextFragment {
  const id = options?.id ?? crypto.randomUUID();
  return assistant({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: content }],
  });
}

/**
 * Symbol to mark fragments for lazy ID resolution.
 * Uses Symbol.for() to ensure consistent identity across module instances.
 * @internal
 */
export const LAZY_ID = Symbol.for('@deepagents/context:lazy-id');

/**
 * Lazy fragment configuration for ID resolution.
 */
export interface LazyConfig {
  type: 'last-assistant';
  content: string;
}

/**
 * Lazy fragment that gets its ID resolved during save().
 */
export interface LazyFragment extends ContextFragment {
  [LAZY_ID]?: LazyConfig;
}

/**
 * Check if a fragment needs lazy ID resolution.
 */
export function isLazyFragment(
  fragment: ContextFragment,
): fragment is LazyFragment {
  return LAZY_ID in fragment;
}

/**
 * Create an assistant message fragment that uses the last assistant's ID.
 *
 * - If a pending/persisted assistant message exists, updates it
 * - If none exists, creates a new assistant message
 *
 * Useful for self-correction flows where retries should update
 * the same message instead of creating duplicates.
 *
 * @example
 * ```ts
 * // In guardrail retry loop:
 * context.set(lastAssistantMessage(correctedContent));
 * await context.save(); // ID resolved here
 * ```
 */
export function lastAssistantMessage(content: string): ContextFragment {
  return {
    name: 'assistant',
    type: 'message',
    persist: true,
    data: 'content',
    [LAZY_ID]: {
      type: 'last-assistant',
      content,
    },
  } as LazyFragment;
}
