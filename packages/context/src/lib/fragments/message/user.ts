import { type UIMessage, generateId } from 'ai';

import { type MessageFragment } from '../../fragments.ts';

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
