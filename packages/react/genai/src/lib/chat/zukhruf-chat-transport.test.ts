import { APICallError, type UIMessage, type UIMessageChunk } from 'ai';
import { expect, it, vi } from 'vitest';

import type { ChatDataTypes } from '@deepagents/context';
import {
  type SerializedToolRegistry,
  ZukhrufChatTransport,
} from '@deepagents/react-genai';

type ChatMessage = UIMessage<unknown, ChatDataTypes>;

const api = '/zukhruf/v1/session';
const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
const tools = {
  ask_user_question: {
    description: 'Ask the user a question',
    inputSchema: {
      properties: { question: { type: 'string' } },
      required: ['question'],
      type: 'object',
    },
  },
} satisfies SerializedToolRegistry;

it('creates, continues, streams, and cancels a session', async () => {
  const requests: Array<{
    url: string;
    method: string;
    headers: Headers;
    body?: unknown;
  }> = [];
  const request: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(input),
      method,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === 'POST' && !String(input).endsWith('/cancel')) {
      return Response.json(
        { ok: true, sessionId, turnId: crypto.randomUUID() },
        { status: 202 },
      );
    }
    if (method === 'POST') return new Response(null, { status: 204 });
    return new Response(
      'data: {"type":"text-delta","id":"text-1","delta":"Hello"}\n\n' +
        'data: [DONE]\n\n',
      {
        headers: {
          'content-type': 'text/event-stream',
          'x-vercel-ai-ui-message-stream': 'v1',
        },
      },
    );
  };
  const transport = new ZukhrufChatTransport({
    api,
    fetch: request,
    tools,
  });
  const message: ChatMessage = {
    id: 'message-1',
    role: 'user',
    parts: [
      { type: 'text', text: '  Hello  ' },
      {
        type: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        url: 'data:text/plain;base64,bm90ZQ==',
      },
    ],
    metadata: { locale: { language: 'Arabic' } },
  };
  const abort = new AbortController();

  const first = await transport.sendMessages({
    abortSignal: abort.signal,
    chatId: sessionId,
    messageId: message.id,
    messages: [message],
    trigger: 'submit-message',
  });
  expect(await Array.fromAsync(first)).toEqual([
    {
      type: 'text-delta',
      id: 'text-1',
      delta: 'Hello',
    } satisfies UIMessageChunk,
  ]);
  expect(requests[0]).toMatchObject({
    url: `${api}/${sessionId}`,
    method: 'POST',
    body: { sessionId, message, trigger: 'submit-message', tools },
  });
  expect(requests[0].headers.get('idempotency-key')).toBeNull();
  expect(requests[1].url).toBe(`${api}/${sessionId}/stream`);

  const continuation: ChatMessage = {
    id: 'message-2',
    role: 'user',
    parts: [{ type: 'text', text: 'Continue' }],
  };
  await transport.sendMessages({
    abortSignal: undefined,
    chatId: sessionId,
    messageId: continuation.id,
    messages: [message, continuation],
    trigger: 'submit-message',
  });
  expect(requests[2]).toMatchObject({
    url: `${api}/${sessionId}`,
    body: {
      sessionId,
      message: continuation,
      trigger: 'submit-message',
      tools,
    },
  });

  await transport.sendMessages({
    abortSignal: undefined,
    chatId: sessionId,
    messageId: 'assistant-1',
    messages: [message, continuation],
    trigger: 'regenerate-message',
  });
  expect(requests[4]).toMatchObject({
    url: `${api}/${sessionId}`,
    body: {
      sessionId,
      message: continuation,
      trigger: 'regenerate-message',
      tools,
    },
  });

  abort.abort();
  await transport.cancel(sessionId);
  expect(
    requests
      .filter(({ url }) => url.endsWith('/cancel'))
      .map(({ method, url }) => ({ method, url })),
  ).toEqual([{ method: 'POST', url: `${api}/${sessionId}/cancel` }]);
});

it('reconnects the AgentProvider chat ID without transport session state', async () => {
  const requests: string[] = [];
  const request: typeof fetch = async (input) => {
    requests.push(String(input));
    return new Response('data: [DONE]\n\n', {
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
      },
    });
  };
  const transport = new ZukhrufChatTransport({ api, fetch: request });
  await transport.reconnectToStream({ chatId: sessionId });
  expect(requests).toEqual([`${api}/${sessionId}/stream`]);
});

it('rejects a response for a different session ID', async () => {
  const transport = new ZukhrufChatTransport({
    api,
    fetch: async () =>
      Response.json(
        {
          ok: true,
          sessionId: '497f6eca-6276-4993-bfeb-53cbbbba6f08',
          turnId: crypto.randomUUID(),
        },
        { status: 202 },
      ),
  });

  await expect(
    transport.sendMessages({
      abortSignal: undefined,
      chatId: sessionId,
      messageId: 'message-1',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
      ],
      trigger: 'submit-message',
    }),
  ).rejects.toThrow('different session ID');
});

it('serializes element descriptors into the request body without client fields', async () => {
  const bodies: unknown[] = [];
  const request: typeof fetch = async (input, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json(
        { ok: true, sessionId, turnId: crypto.randomUUID() },
        { status: 202 },
      );
    }
    return new Response('data: [DONE]\n\n', {
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
      },
    });
  };
  const transport = new ZukhrufChatTransport({
    api,
    fetch: request,
    elements: [
      {
        name: 'followup',
        description: 'Suggest a follow-up question',
        allowedAttributes: ['question'],
        component: () => null,
        tips: [{ text: 'Click to ask', cooldown: 'rare' }],
      },
    ],
  });

  await transport.sendMessages({
    abortSignal: undefined,
    chatId: sessionId,
    messageId: 'message-1',
    messages: [
      {
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ],
    trigger: 'submit-message',
  });

  expect(bodies[0]).toEqual({
    sessionId,
    message: {
      id: 'message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    },
    trigger: 'submit-message',
    elements: [
      {
        name: 'followup',
        description: 'Suggest a follow-up question',
        allowedAttributes: ['question'],
      },
    ],
  });
});

it('resolves the default fetch implementation at request time', async () => {
  const transport = new ZukhrufChatTransport({ api });
  const request = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method === 'POST') {
      return Response.json(
        { ok: true, sessionId, turnId: crypto.randomUUID() },
        { status: 202 },
      );
    }
    return new Response('data: [DONE]\n\n', {
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
      },
    });
  });
  vi.stubGlobal('fetch', request);

  await transport.sendMessages({
    abortSignal: undefined,
    chatId: sessionId,
    messageId: 'message-1',
    messages: [
      {
        id: 'message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ],
    trigger: 'submit-message',
  });

  expect(request).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});

it('uploads a file to the session uploads endpoint and returns the receipt', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const receipt = {
    path: `/workspace/.uploads/${sessionId}/f1.png`,
    name: 'shot 1.png',
    mediaType: 'image/png',
    size: 4,
    url: `https://api.test${api}/${sessionId}/uploads/f1`,
  };
  const transport = new ZukhrufChatTransport({
    api,
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json(receipt, { status: 201 });
    },
  });
  const file = new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    'shot 1.png',
    {
      type: 'image/png',
    },
  );

  const returned = await transport.uploadFile(sessionId, file);

  expect(returned).toEqual(receipt);
  expect(requests).toHaveLength(1);
  const [{ url, init }] = requests;
  const headers = new Headers(init?.headers);
  expect(url).toBe(`${api}/${sessionId}/uploads`);
  expect(init?.method).toBe('POST');
  expect(headers.get('content-type')).toBe('image/png');
  expect(headers.get('x-upload-filename')).toBe('shot%201.png');
  expect(init?.body).toBe(file);
});

it('accepts video and audio upload receipts', async () => {
  const receipt = {
    path: `/workspace/.uploads/${sessionId}/f1.mov`,
    name: 'IMG_0002.MOV',
    mediaType: 'video/quicktime',
    size: 4,
    url: `https://api.test${api}/${sessionId}/uploads/f1.mov`,
  };
  const transport = new ZukhrufChatTransport({
    api,
    fetch: async () => Response.json(receipt, { status: 201 }),
  });

  const returned = await transport.uploadFile(
    sessionId,
    new File([new Uint8Array([0, 0, 0, 0x20])], 'IMG_0002.MOV', {
      type: 'video/quicktime',
    }),
  );

  expect(returned).toEqual(receipt);
});

it("rejects a semantically invalid upload receipt with the AI SDK's APICallError, carrying the status and the body", async () => {
  const receipt = {
    path: '/workspace/.uploads/file',
    name: 'shot.svg',
    mediaType: 'image/svg+xml',
    size: -1,
    url: 'not a URL',
  };
  const transport = new ZukhrufChatTransport({
    api,
    fetch: async () => Response.json(receipt, { status: 201 }),
  });

  const error = await transport
    .uploadFile(
      sessionId,
      new File([new Uint8Array([0xff, 0xd8])], 'shot.jpg', {
        type: 'image/jpeg',
      }),
    )
    .catch((error: unknown) => error);

  expect(APICallError.isInstance(error)).toBe(true);
  expect(error).toMatchObject({
    statusCode: 201,
    responseBody: JSON.stringify(receipt),
  });
});

it("rejects an upload receipt that is not JSON with the AI SDK's APICallError", async () => {
  const transport = new ZukhrufChatTransport({
    api,
    fetch: async () =>
      new Response('<html>proxy error</html>', { status: 201 }),
  });

  const error = await transport
    .uploadFile(
      sessionId,
      new File([new Uint8Array([0xff, 0xd8])], 'shot.jpg', {
        type: 'image/jpeg',
      }),
    )
    .catch((error: unknown) => error);

  expect(APICallError.isInstance(error)).toBe(true);
  expect(error).toMatchObject({
    statusCode: 201,
    responseBody: '<html>proxy error</html>',
  });
});

it("rejects a refused upload with the AI SDK's APICallError, carrying the status and the server's body", async () => {
  const body = {
    error: 'Unsupported Media Type',
    cause: {
      code: 'zukhruf/unsupported-media-type',
      detail: 'Uploads must be one of image/png, image/jpeg',
    },
  };
  const transport = new ZukhrufChatTransport({
    api,
    fetch: async () => Response.json(body, { status: 415 }),
  });

  const error = await transport
    .uploadFile(
      sessionId,
      new File(['note'], 'notes.txt', { type: 'text/plain' }),
    )
    .catch((rejection: unknown) => rejection);

  expect(APICallError.isInstance(error)).toBe(true);
  expect(error).toMatchObject({
    statusCode: 415,
    url: `${api}/${sessionId}/uploads`,
    responseBody: JSON.stringify(body),
  });
});

it("rejects a refused cancel with the AI SDK's APICallError, carrying the status and the server's body", async () => {
  const body = { error: 'Internal Server Error' };
  const transport = new ZukhrufChatTransport({
    api,
    fetch: async () => Response.json(body, { status: 500 }),
  });

  const error = await transport
    .cancel(sessionId)
    .catch((rejection: unknown) => rejection);

  expect(APICallError.isInstance(error)).toBe(true);
  expect(error).toMatchObject({
    statusCode: 500,
    url: `${api}/${sessionId}/cancel`,
    responseBody: JSON.stringify(body),
  });
});
