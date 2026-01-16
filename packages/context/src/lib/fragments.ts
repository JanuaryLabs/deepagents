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
export function user(content: string | UIMessage): ContextFragment {
  const message =
    typeof content === 'string'
      ? {
          id: generateId(),
          role: 'user',
          parts: [{ type: 'text', text: content }],
        }
      : content;
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
          role: 'user',
          parts: [{ type: 'text', text: content }],
        }
      : content;
  return {
    id: message.id,
    name: 'message',
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
