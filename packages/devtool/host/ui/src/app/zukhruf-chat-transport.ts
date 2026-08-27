import { DefaultChatTransport, type UIMessage, isTextUIPart } from 'ai';

export interface ZukhrufChatTransportOptions {
  api: string;
  sessionId?: string;
  onSession?: (sessionId: string) => void;
  fetch?: typeof globalThis.fetch;
}

type AcceptedTurn = {
  ok: true;
  sessionId: string;
  turnId: string;
};

export class ZukhrufChatTransport extends DefaultChatTransport<UIMessage> {
  readonly #state: { sessionId?: string };

  constructor({
    api,
    sessionId,
    onSession,
    fetch: request = globalThis.fetch,
  }: ZukhrufChatTransportOptions) {
    const state = { sessionId };
    super({
      api,
      fetch: async (input, init) => {
        const response = await request(input, init);
        if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || !response.ok) {
          return response;
        }

        const accepted = await response.json();
        if (!isAcceptedTurn(accepted)) {
          throw new Error('Zukhruf returned an invalid accepted-turn response');
        }

        const previousSessionId = state.sessionId;
        state.sessionId = accepted.sessionId;
        if (previousSessionId !== accepted.sessionId) {
          onSession?.(accepted.sessionId);
        }

        const signal = init?.signal;
        const cancel = () => {
          void request(sessionUrl(api, accepted.sessionId, 'cancel'), {
            method: 'POST',
          }).catch(() => undefined);
        };
        signal?.addEventListener('abort', cancel, { once: true });

        return request(sessionUrl(api, accepted.sessionId, 'stream'), {
          headers: { accept: 'text/event-stream' },
          method: 'GET',
          signal,
        });
      },
      prepareSendMessagesRequest: ({ messages, messageId, headers }) => {
        const message = messages.findLast(({ role }) => role === 'user');
        const input = message?.parts
          .filter(isTextUIPart)
          .map(({ text }) => text)
          .join('')
          .trim();
        if (!message || !input) {
          throw new Error('A user text message is required');
        }

        const requestHeaders = new Headers(headers);
        requestHeaders.set('idempotency-key', messageId ?? message.id);
        return {
          api: state.sessionId ? sessionUrl(api, state.sessionId) : api,
          body: { input },
          headers: requestHeaders,
        };
      },
      prepareReconnectToStreamRequest: ({ headers }) => ({
        api: state.sessionId ? sessionUrl(api, state.sessionId, 'stream') : api,
        headers,
      }),
    });
    this.#state = state;
  }

  override reconnectToStream(
    options: Parameters<
      DefaultChatTransport<UIMessage>['reconnectToStream']
    >[0],
  ) {
    return this.#state.sessionId
      ? super.reconnectToStream(options)
      : Promise.resolve(null);
  }
}

function sessionUrl(api: string, sessionId: string, action?: string) {
  return `${api}/${encodeURIComponent(sessionId)}${action ? `/${action}` : ''}`;
}

function isAcceptedTurn(value: unknown): value is AcceptedTurn {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === true &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'turnId' in value &&
    typeof value.turnId === 'string'
  );
}
