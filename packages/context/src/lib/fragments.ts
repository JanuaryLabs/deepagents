import { type UIMessage, generateId } from 'ai';

import type { FragmentCodec } from './codec/codec.ts';
import type { LoadContext } from './resolvers/types.ts';

/**
 * Fragment type identifier.
 * - 'fragment': Regular context fragment (default)
 * - 'message': Conversation message (user/assistant)
 * - 'verbatim': Literal prompt text every renderer emits as-is
 */
export type FragmentType = 'fragment' | 'message' | 'verbatim';

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
 * lazy value (function, generator, iterable) that is materialized by the
 * resolver chain at engine.resolve() time. Async data is a function that
 * returns a promise: a bare promise would start before resolve() and could
 * reject before anything awaits it.
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
    typeof data.name === 'string'
  );
}

/**
 * Runtime check that a value fits {@link FragmentData}. Lazy values
 * (functions, iterables) are accepted as they are, because only the resolver
 * chain can tell what they produce. A bare promise does not fit.
 */
export function isFragmentData(value: unknown): value is FragmentData {
  return fitsFragmentData(value, new WeakSet());
}

function fitsFragmentData(value: unknown, visited: WeakSet<object>): boolean {
  if (typeof value !== 'object') {
    return typeof value !== 'bigint' && typeof value !== 'symbol';
  }
  if (value === null || visited.has(value)) return true;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => fitsFragmentData(item, visited));
  }
  if (value instanceof Promise) return false;
  if (Symbol.asyncIterator in value || Symbol.iterator in value) return true;
  if (isFragment(value)) return fitsFragmentData(value.data, visited);
  return Object.values(value).every((item) => fitsFragmentData(item, visited));
}

/**
 * A plain object with string keys and FragmentData values.
 */
export type FragmentObject = Record<string, FragmentData>;

/**
 * Type guard for plain objects in fragment data. The resolver chain dispatches
 * iterables to handlers first, so this guard would not normally see them.
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
    const decoded = fragment.codec.decode();
    if (!isFragmentData(decoded)) {
      throw new Error(
        `Fragment "${fragment.name}" codec decoded a value that is not fragment data`,
      );
    }
    return decoded;
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
 * Literal prompt text that every renderer emits exactly as written.
 */
export interface VerbatimFragment extends ContextFragment<string> {
  name: 'verbatim';
  type: 'verbatim';
  data: string;
}

export function isVerbatimFragment(
  fragment: ContextFragment,
): fragment is VerbatimFragment {
  return fragment.type === 'verbatim';
}

/**
 * Create a fragment whose text reaches the prompt as-is: every renderer
 * (XML, Markdown, TOML, TOON) emits it unescaped, unindented and without a
 * tag, heading or key of its own, at its position among the top-level
 * fragments, separated from its siblings the way that renderer separates any
 * two fragments. Use it for prompt text whose exact bytes matter, such as a
 * catalog copied from another harness.
 *
 * A verbatim fragment renders only at the top level: nested inside another
 * fragment it would sit inside that fragment's markup, so renderers throw.
 *
 * @example
 * ```ts
 * context.set(role('You are a helpful assistant.'), verbatim('## Skills\n...'));
 * ```
 */
export function verbatim(text: string): VerbatimFragment {
  if (text === '') {
    throw new Error('verbatim() needs non-empty text');
  }
  return { name: 'verbatim', type: 'verbatim', data: text };
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
 * `openai.itemId` in different steps. Sent back to the Responses API those
 * become duplicate items ("Duplicate item found with id rs_..."), because
 * `convertToModelMessages` splits the turn per step and `@ai-sdk/openai` only
 * merges an item's parts within a single message. Moving every later part next
 * to the item's first part keeps the item in one step, where the provider
 * merges it losslessly: every summary, and the encrypted content that only the
 * item's last part carries under `store: false`.
 *
 * TEMPORARY workaround for an upstream gap: `@ai-sdk/openai`'s
 * `convertToOpenAIResponsesInput` resets its reasoning de-dup map per assistant
 * message, so it cannot collapse the same item id once `convertToModelMessages`
 * has split the turn across messages. Remove this once `@ai-sdk/openai`
 * de-duplicates reasoning items across the whole request. Related (closed on
 * older versions, the across-steps variant still reproduces on 3.0.61):
 * https://github.com/vercel/ai/issues/7883
 */
function withReasoningItemsGrouped(message: UIMessage): UIMessage {
  const partsByItemId = new Map<string, UIMessage['parts']>();
  for (const part of message.parts) {
    const itemId = reasoningItemIdOf(part);
    if (itemId === undefined) continue;
    const itemParts = partsByItemId.get(itemId);
    if (itemParts) {
      itemParts.push(part);
    } else {
      partsByItemId.set(itemId, [part]);
    }
  }
  if (partsByItemId.values().every((itemParts) => itemParts.length === 1)) {
    return message;
  }

  // The first part of an item emits the whole group; later parts emit nothing.
  const parts = message.parts.flatMap((part) => {
    const itemId = reasoningItemIdOf(part);
    if (itemId === undefined) return [part];
    const itemParts = partsByItemId.get(itemId) ?? [];
    partsByItemId.delete(itemId);
    return itemParts;
  });
  return { ...message, parts };
}

function reasoningItemIdOf(
  part: UIMessage['parts'][number],
): string | undefined {
  if (part.type !== 'reasoning') return undefined;
  const itemId = part.providerMetadata?.openai?.itemId;
  return typeof itemId === 'string' ? itemId : undefined;
}

export function assistant(message: UIMessage): MessageFragment {
  const normalized = withReasoningItemsGrouped(message);
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
