import { DefaultChatTransport, type UIMessage } from 'ai';
import { z } from 'zod';

import { type ElementDescriptor, toDescriptor } from '@deepagents/elements';

import type { GenAIInteractiveElement } from '../elements/interactive-element.ts';
import type { SerializedToolRegistry } from './tools-schema.ts';

/** Carries the URI-encoded original filename alongside the raw upload body. */
const UPLOAD_FILENAME_HEADER = 'x-upload-filename';

export const uploadReceiptSchema = z.strictObject({
  path: z.string().startsWith('/'),
  name: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  size: z.int().nonnegative(),
  url: z.url(),
});

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
  private readonly sessionsApi: string;
  private readonly request: typeof globalThis.fetch;

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
    this.sessionsApi = sessionsApi;
    this.request = request;
  }

  /**
   * Store an image under the session and return its receipt. The session does
   * not need to exist yet.
   */
  async uploadFile(sessionId: string, file: File) {
    const response = await this.request(
      `${sessionApi(this.sessionsApi, sessionId)}/uploads`,
      {
        method: 'POST',
        headers: {
          'content-type': file.type,
          [UPLOAD_FILENAME_HEADER]: encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    if (!response.ok) {
      throw new Error(await describeUploadFailure(response, file));
    }
    const receipt = uploadReceiptSchema.safeParse(await response.json());
    if (!receipt.success) {
      throw new Error('Zukhruf returned an invalid upload response');
    }
    return receipt.data;
  }
}

function sessionApi(sessionsApi: string, sessionId: string) {
  return `${sessionsApi}/${encodeURIComponent(sessionId)}`;
}

async function describeUploadFailure(
  response: Response,
  file: File,
): Promise<string> {
  const summary = `Uploading ${file.name} failed with HTTP ${response.status}`;
  const body: unknown = await response.json().catch(() => null);
  const reason = failureReason(body);
  return reason ? `${summary}: ${reason}` : summary;
}

function failureReason(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const cause =
    'cause' in body && typeof body.cause === 'object' && body.cause !== null
      ? body.cause
      : null;
  const code =
    cause && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : null;
  const detail =
    cause && 'detail' in cause && typeof cause.detail === 'string'
      ? cause.detail
      : 'error' in body && typeof body.error === 'string'
        ? body.error
        : null;
  const reason = [code, detail].filter((part) => part !== null).join(' — ');
  return reason || null;
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
