import { groq } from '@ai-sdk/groq';
import { type UIMessage, createUIMessageStream, generateId } from 'ai';

import { type Agent, agent, execute, lmstudio, user } from '@deepagents/agent';

function pipe(...agents: Agent<unknown>[]) {
  return (messages: UIMessage[]) => {
    return createUIMessageStream({
      execute: async ({ writer }) => {
        for (const agent of agents) {
          const result = execute(agent, messages, {});
          writer.merge(
            result.toUIMessageStream({
              generateMessageId: generateId,
              originalMessages: messages,
              onFinish: async ({ responseMessage }) => {
                messages.push(responseMessage);
              },
            }),
          );
          await result.consumeStream();
        }
      },
    });
  };
}

const run = pipe(
  agent({
    name: 'good_agent',
    prompt: `You are a helpful assistant that provides positive responses.`,
    model: lmstudio('qwen/qwen3-4b-2507'),
  }),
  agent({
    name: 'bad_agent',
    prompt: `You are a harmful assistant that provides negative responses.`,
    model: lmstudio('qwen/qwen3-4b-2507'),
  }),
);

run([user('Hello!')]);
