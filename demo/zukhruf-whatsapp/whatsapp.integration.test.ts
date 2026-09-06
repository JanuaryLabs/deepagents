import { openai } from '@ai-sdk/openai';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { WhatsAppGroup } from '@deepagents/demo-zukhruf-whatsapp';

import participants from './participants.ts';

const RESPONSES = 'https://api.openai.com/v1/responses';

/** The Responses API request body the OpenAI provider sends. */
interface ResponsesRequest {
  input: Array<{
    role?: string;
    type?: string;
    content?: unknown;
  }>;
}

function itemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part: { text?: string }) =>
      typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n');
}

function systemText(request: ResponsesRequest): string {
  return (
    request.input
      // Reasoning models receive the system prompt as a developer message.
      .filter((item) => item.role === 'system' || item.role === 'developer')
      .map((item) => itemText(item.content))
      .join('\n')
  );
}

const usage = { input_tokens: 1, output_tokens: 1 };

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  return new HttpResponse(body.join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function textResponse(text: string): Response {
  return sse([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1' },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      delta: text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_1' },
    },
    { type: 'response.completed', response: { usage } },
  ]);
}

function toolResponse(
  name: string,
  callId: string,
  input: Record<string, unknown>,
): Response {
  const item = {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(input),
  };
  return sse([
    { type: 'response.output_item.added', output_index: 0, item },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { ...item, status: 'completed' },
    },
    { type: 'response.completed', response: { usage } },
  ]);
}

test('reserves the human author name from participants', async () => {
  await assert.rejects(
    WhatsAppGroup.create({
      userId: 'user-1',
      participants: [
        {
          name: 'user',
          specialty: 'Should receive human messages.',
          model: openai('gpt-5.6-terra'),
        },
      ],
    }),
    /participant name "user" is reserved for the human author/,
  );
});

test('every member sees a group message concurrently and only volunteers publish replies', async () => {
  // The provider refuses to build a request without a key, even one msw answers.
  process.env.OPENAI_API_KEY ??= 'test';
  const firstNotificationStarted = Promise.withResolvers<void>();
  const firstParticipants = new Set<string>();
  let activeParticipationChecks = 0;
  let maxActiveParticipationChecks = 0;
  const enterFirstNotification = async (name: string) => {
    firstParticipants.add(name);
    activeParticipationChecks++;
    maxActiveParticipationChecks = Math.max(
      maxActiveParticipationChecks,
      activeParticipationChecks,
    );
    if (firstParticipants.size === participants.length) {
      firstNotificationStarted.resolve();
    }
    await Promise.race([
      firstNotificationStarted.promise,
      sleep(2_000).then(() => {
        throw new Error(
          'members did not receive the notification concurrently',
        );
      }),
    ]);
    activeParticipationChecks--;
  };

  const calls: Record<string, ResponsesRequest[]> = {};
  const openaiApi = setupServer(
    http.post(RESPONSES, async ({ request }) => {
      const body = (await request.json()) as ResponsesRequest;
      const name = /You are (?<name>\w+) in a WhatsApp-style group chat/.exec(
        systemText(body),
      )?.groups?.name;
      assert.ok(name, systemText(body));
      const call = (calls[name] ??= []).push(body);
      if (call === 1) await enterFirstNotification(name);
      if (name === 'researcher') {
        return call === 1
          ? toolResponse('reply_to_group', 'research-reply', {
              message: 'The evidence supports a small pilot first.',
            })
          : textResponse('Reply posted.');
      }
      return textResponse('I have nothing useful to add.');
    }),
  );
  openaiApi.listen({ onUnhandledRequest: 'bypass' });
  try {
    await using group = await WhatsAppGroup.create({
      userId: 'user-1',
      participants,
    });

    const messages = await group.send(
      'Should we launch the proposed product immediately?',
    );

    assert.equal(maxActiveParticipationChecks, participants.length);
    assert.deepEqual(
      messages.map(({ author, content }) => ({ author, content })),
      [
        {
          author: 'user',
          content: 'Should we launch the proposed product immediately?',
        },
        {
          author: 'researcher',
          content: 'The evidence supports a small pilot first.',
        },
      ],
    );
    for (const { name } of participants) {
      if (name === 'researcher') continue;
      assert.equal(
        JSON.stringify(calls[name].at(-1)).includes(
          'The evidence supports a small pilot first.',
        ),
        true,
        `the researcher reply is broadcast back to ${name}`,
      );
    }
  } finally {
    openaiApi.close();
  }
});
