import type { ChatTransport, UIMessage } from 'ai';

import { clearPrefill, readPrefill } from './prefill.ts';

/**
 * The host's transport, clearing the pending prefill once it accepts a turn
 * that holds the prefill's message: the prefill's own send, a retry of it, or
 * a newer question asked after it. A transport accepts a turn when its
 * `sendMessages` resolves with a stream; it throws instead when the request
 * fails, whether a non-2xx answer, a network error or an abort. The chat's
 * status cannot say this: an abort settles it on `ready` either way, and a
 * stream that fails after acceptance settles it on `error`.
 */
export function prefillTransport<M extends UIMessage>(
  transport: ChatTransport<M>,
): ChatTransport<M> {
  return {
    get resumeStreamIsReplay() {
      return transport.resumeStreamIsReplay;
    },
    close: () => transport.close?.(),
    sendMessages: async (request) => {
      const stream = await transport.sendMessages(request);
      const prefill = readPrefill();
      if (
        prefill &&
        request.messages.some((message) => message.id === prefill.messageId)
      ) {
        clearPrefill();
      }
      return stream;
    },
    reconnectToStream: (request) => transport.reconnectToStream(request),
  };
}
