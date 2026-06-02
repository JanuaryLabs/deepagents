import { type UIMessage, generateId } from 'ai';

import type { FragmentCodec } from './codec/codec.ts';
import type { LoadContext } from './resolvers/types.ts';

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
  data?: T;
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
 * Fragment data can be a primitive, array, object, nested fragment, or a
 * lazy value (function, generator, promise, iterable) that is materialized
 * by the resolver chain at engine.resolve() time.
 */
export type FragmentData =
  | string
  | number
  | null
  | undefined
  | boolean
  | ContextFragment
  | FragmentData[]
  | { [key: string]: FragmentData }
  | ((
      ctx: LoadContext,
    ) =>
      | FragmentData
      | Promise<FragmentData>
      | Iterable<FragmentData>
      | AsyncIterable<FragmentData>)
  | Promise<FragmentData>
  | Iterable<FragmentData>
  | AsyncIterable<FragmentData>;

/**
 * Type guard to check if data is a ContextFragment.
 */
export function isFragment(data: unknown): data is ContextFragment {
  return (
    typeof data === 'object' &&
    data !== null &&
    'name' in data &&
    ('data' in data || 'codec' in data) &&
    typeof (data as ContextFragment).name === 'string'
  );
}

/**
 * A plain object with string keys and FragmentData values.
 */
export type FragmentObject = Record<string, FragmentData>;

/**
 * Type guard for plain objects in fragment data. The resolver chain dispatches
 * Promises/iterables to handlers first, so this guard would not normally see them.
 * Kept defensive so direct render paths that bypass the resolver still reject lazy values.
 */
export function isFragmentObject(data: unknown): data is FragmentObject {
  if (typeof data !== 'object' || data === null) return false;
  if (Array.isArray(data)) return false;
  if (data instanceof Promise) return false;
  if (Symbol.asyncIterator in data || Symbol.iterator in data) return false;
  if (isFragment(data)) return false;
  return true;
}

/**
 * A context fragment that represents a conversation message (user or assistant).
 * Stricter than ContextFragment: requires type='message', a codec, and persistence.
 */
export interface MessageFragment extends ContextFragment {
  type: 'message';
  persist: true;
  codec: FragmentCodec;
}

/**
 * Type guard to check if a fragment is a message fragment.
 */
export function isMessageFragment(
  fragment: ContextFragment,
): fragment is MessageFragment {
  return fragment.type === 'message';
}

export function getFragmentData(fragment: ContextFragment): FragmentData {
  if (fragment.codec) {
    return fragment.codec.decode() as FragmentData;
  }

  if ('data' in fragment) {
    return fragment.data;
  }

  throw new Error(`Fragment "${fragment.name}" is missing data and codec`);
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
/**
 * A single OpenAI reasoning item can span a tool round-trip, so the streamed
 * assistant message may carry several reasoning parts that share one
 * `openai.itemId`. Sent back to the Responses API those become duplicate items
 * ("Duplicate item found with id rs_..."), because `convertToModelMessages`
 * splits the turn per step and `@ai-sdk/openai` only de-duplicates reasoning
 * within a single message. Reasoning items are reference-only, so keeping the
 * first occurrence and dropping later repeats is lossless.
 *
 * TEMPORARY workaround for an upstream gap: `@ai-sdk/openai`'s
 * `convertToOpenAIResponsesInput` resets its reasoning de-dup map per assistant
 * message, so it cannot collapse the same item id once `convertToModelMessages`
 * has split the turn across messages. Remove this once `@ai-sdk/openai`
 * de-duplicates reasoning items across the whole request. Related (closed on
 * older versions, the across-steps variant still reproduces on 3.0.61):
 * https://github.com/vercel/ai/issues/7883
 */
function withoutDuplicateReasoningParts(message: UIMessage): UIMessage {
  const seenReasoningItemIds = new Set<string>();
  let dropped = false;
  const parts = message.parts.filter((part) => {
    if (part.type !== 'reasoning') return true;
    const itemId = part.providerMetadata?.openai?.itemId;
    if (typeof itemId !== 'string') return true;
    if (seenReasoningItemIds.has(itemId)) {
      dropped = true;
      return false;
    }
    seenReasoningItemIds.add(itemId);
    return true;
  });
  return dropped ? { ...message, parts } : message;
}

export function assistant(message: UIMessage): MessageFragment {
  const normalized = withoutDuplicateReasoningParts(message);
  return {
    id: normalized.id,
    name: 'assistant',
    type: 'message',
    persist: true,
    codec: {
      decode() {
        return normalized;
      },
      encode() {
        return normalized;
      },
    },
  };
}

export type ChatMessage = UIMessage | MessageFragment;

export function toMessageFragment(item: ChatMessage): MessageFragment {
  if (isFragment(item) && isMessageFragment(item)) {
    return item;
  }
  return message(item);
}

export function message(content: string | UIMessage): MessageFragment {
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
): MessageFragment {
  const id = options?.id ?? crypto.randomUUID();
  return assistant({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: content }],
  });
}
