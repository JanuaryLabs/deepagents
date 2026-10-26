import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';

for (const complete of [false, true]) {
  it(`persists a provider stream that ${complete ? 'finishes normally' : 'closes before its finish event'}`, async () => {
    const store = new SqliteStreamStore(':memory:');
    let requests = 0;
    const model = createOpenAI({
      apiKey: 'fixture',
      fetch: async () => {
        requests++;
        const chunks = [
          {
            delta: { role: 'assistant', content: 'Partial answer' },
            finish_reason: null,
          },
          ...(complete ? [{ delta: {}, finish_reason: 'stop' }] : []),
        ];
        return new Response(
          chunks
            .map(
              (choice) =>
                `data: ${JSON.stringify({
                  id: 'chatcmpl-cutoff',
                  object: 'chat.completion.chunk',
                  created: 0,
                  model: 'gpt-6.1-sol',
                  choices: [{ index: 0, ...choice }],
                })}\n\n`,
            )
            .join('') + (complete ? 'data: [DONE]\n\n' : ''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    }).chat('gpt-6.1-sol');

    try {
      const streams = new StreamManager({
        store,
        changeSource: new PollingChangeSource({ reads: store }),
      });
      const result = streamText({ model, prompt: 'Reply', maxRetries: 0 });
      await streams.register('turn');

      await streams.persist(result.toUIMessageStream(), 'turn');

      assert.equal(
        (await store.getStream('turn'))?.status,
        complete ? 'completed' : 'failed',
      );
      assert.equal(
        await result.finishReason,
        complete ? 'stop' : 'interrupted',
      );
      const chunks = (await store.getChunks('turn')).map(({ data }) => data);
      assert.ok(
        chunks.some(
          (chunk) =>
            chunk.type === 'text-delta' && chunk.delta === 'Partial answer',
        ),
      );
      const replay = await Array.fromAsync(streams.watch('turn'));
      assert.equal(
        replay.some((chunk) => chunk.type === 'error'),
        !complete,
      );
      assert.equal(
        requests,
        1,
        'a partial answer must not be retried automatically',
      );
    } finally {
      store.close();
    }
  });
}
