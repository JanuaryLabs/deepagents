import type { UIMessage, UIMessageChunk } from 'ai';
import assert from 'node:assert/strict';
import test from 'node:test';

import { ZukhrufChatTransport } from './zukhruf-chat-transport.ts';

const api = '/zukhruf/v1/session';
const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';

test('ZukhrufChatTransport creates, continues, streams, and cancels a session', async (t) => {
  const requests: Array<{
    url: string;
    method: string;
    headers: Headers;
    body?: unknown;
  }> = [];
  const sessions: string[] = [];
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
    onSession: (id) => sessions.push(id),
  });
  const message: UIMessage = {
    id: 'message-1',
    role: 'user',
    parts: [{ type: 'text', text: '  Hello  ' }],
  };
  const abort = new AbortController();

  const first = await transport.sendMessages({
    abortSignal: abort.signal,
    chatId: 'draft-1',
    messageId: message.id,
    messages: [message],
    trigger: 'submit-message',
  });
  assert.deepEqual(await Array.fromAsync(first), [
    {
      type: 'text-delta',
      id: 'text-1',
      delta: 'Hello',
    } satisfies UIMessageChunk,
  ]);
  assert.deepEqual(sessions, [sessionId]);
  assert.equal(requests[0].url, api);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.get('idempotency-key'), message.id);
  assert.deepEqual(requests[0].body, { input: 'Hello' });
  assert.equal(requests[1].url, `${api}/${sessionId}/stream`);

  await transport.sendMessages({
    abortSignal: undefined,
    chatId: 'draft-1',
    messageId: 'message-2',
    messages: [
      message,
      {
        id: 'message-2',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue' }],
      },
    ],
    trigger: 'submit-message',
  });
  assert.equal(requests[2].url, `${api}/${sessionId}`);
  assert.deepEqual(requests[2].body, { input: 'Continue' });

  abort.abort();
  await t.waitFor(
    () =>
      assert(
        requests.some(
          ({ method, url }) =>
            method === 'POST' && url === `${api}/${sessionId}/cancel`,
        ),
      ),
    { interval: 10, timeout: 1_000 },
  );
});

test('ZukhrufChatTransport reconnects only when it has a durable session', async () => {
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
  const draft = new ZukhrufChatTransport({ api, fetch: request });
  assert.equal(await draft.reconnectToStream({ chatId: 'draft-1' }), null);
  assert.deepEqual(requests, []);

  const existing = new ZukhrufChatTransport({
    api,
    fetch: request,
    sessionId,
  });
  await existing.reconnectToStream({ chatId: sessionId });
  assert.deepEqual(requests, [`${api}/${sessionId}/stream`]);
});
