import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { WhatsAppGroup } from '@deepagents/demo-zukhruf-whatsapp';

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

test('every member sees a group message concurrently and only volunteers publish replies', async () => {
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
    if (firstParticipants.size === 2) firstNotificationStarted.resolve();
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

  let researcherCalls = 0;
  const researcher = new MockLanguageModelV4({
    doStream: async () => {
      researcherCalls++;
      if (researcherCalls === 1) {
        await enterFirstNotification('researcher');
        return toolResponse('reply_to_group', 'research-reply', {
          message: 'The evidence supports a small pilot first.',
        });
      }
      return textResponse('Reply posted.');
    },
  });

  let criticCalls = 0;
  const criticPrompts: unknown[] = [];
  const critic = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      criticCalls++;
      criticPrompts.push(prompt);
      if (criticCalls === 1) await enterFirstNotification('critic');
      return textResponse('I have nothing useful to add.');
    },
  });

  await using group = await WhatsAppGroup.create({
    userId: 'user-1',
    participants: [
      {
        name: 'researcher',
        specialty: 'Finds evidence.',
        model: researcher,
      },
      {
        name: 'critic',
        specialty: 'Challenges unsupported claims.',
        model: critic,
      },
    ],
  });

  const messages = await group.send(
    'Should we launch the proposed product immediately?',
  );

  assert.equal(maxActiveParticipationChecks, 2);
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
  assert.equal(
    JSON.stringify(criticPrompts.at(-1)).includes(
      'The evidence supports a small pilot first.',
    ),
    true,
    'the researcher reply is broadcast back to the other group member',
  );
});

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: text },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}

function toolResponse(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}
