import { DefaultChatTransport, type UIMessage } from 'ai';

import { type ElementDescriptor, toDescriptor } from '@deepagents/elements';

import type { GenAIInteractiveElement } from '../elements/interactive-element.ts';
import type { SerializedToolRegistry } from './tools-schema.ts';

export interface ZukhrufChatTransportOptions {
  /** Session collection URL discovered from Zukhruf. */
  api: string;
  fetch?: typeof globalThis.fetch;
  tools?: SerializedToolRegistry;
  /**
   * Interactive elements the client can render. Only their serializable
   * descriptors go over the wire; `component`/`tips` never leave the client.
   */
  elements?: GenAIInteractiveElement[];
}

type AcceptedTurn = {
  ok: true;
  sessionId: string;
  turnId: string;
};

export class ZukhrufChatTransport extends DefaultChatTransport<UIMessage> {
  constructor({
    api,
    fetch: request = (input, init) => globalThis.fetch(input, init),
    tools = {},
    elements = [],
  }: ZukhrufChatTransportOptions) {
    const sessionsApi = trimTrailingSlash(api);
    const descriptors: ElementDescriptor[] = elements.map(toDescriptor);
    super({
      api: sessionsApi,
      fetch: async (input, init) => {
        const response = await request(input, init);
        if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || !response.ok) {
          return response;
        }

        const accepted = await response.json();
        if (!isAcceptedTurn(accepted)) {
          throw new Error('Zukhruf returned an invalid accepted-turn response');
        }
        const sessionApi = trimTrailingSlash(String(input));
        const sessionId = decodeURIComponent(
          sessionApi.slice(sessionApi.lastIndexOf('/') + 1),
        );
        if (accepted.sessionId !== sessionId) {
          throw new Error('Zukhruf returned a different session ID');
        }

        const signal = init?.signal;
        const cancel = () => {
          void request(`${sessionApi}/cancel`, { method: 'POST' }).catch(
            () => undefined,
          );
        };
        signal?.addEventListener('abort', cancel, { once: true });

        return request(`${sessionApi}/stream`, {
          headers: { accept: 'text/event-stream' },
          method: 'GET',
          signal,
        });
      },
      prepareSendMessagesRequest: ({ id, messages, trigger }) => {
        const message = messages[messages.length - 1];
        if (!message) throw new Error('A message is required');
        return {
          api: sessionApi(sessionsApi, id),
          body: {
            sessionId: id,
            message,
            trigger,
            ...(Object.keys(tools).length > 0 ? { tools } : {}),
            ...(descriptors.length > 0 ? { elements: descriptors } : {}),
          },
        };
      },
      prepareReconnectToStreamRequest: ({ headers, id }) => ({
        api: `${sessionApi(sessionsApi, id)}/stream`,
        headers,
      }),
    });
  }
}

function sessionApi(sessionsApi: string, sessionId: string) {
  return `${sessionsApi}/${encodeURIComponent(sessionId)}`;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/$/, '');
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
