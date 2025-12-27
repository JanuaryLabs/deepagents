import { groq } from '@ai-sdk/groq';

import { agent, generate } from '@deepagents/agent';

import { ContextEngine, fragment, hint } from './index.ts';

const context = new ContextEngine();

context.set(
  fragment(
    'hints',
    ...Array.from({ length: 110000 }, (_, i) =>
      hint(`This is hint number ${i + 1}.`),
    ),
  ),
);

// Estimate token count and cost for the current context
const result = await context.estimate('groq:moonshotai/kimi-k2-instruct-0905');

const convo = context.converation();

convo.user('Summarize the hints into a short paragraph.');
convo.assistant();

console.dir(result, { depth: null });

const userSimulator = agent({
  name: 'Test Agent',
  model: groq('openai/gpt-oss-20b'),
  prompt: 'Simulate a user.',
  context: context,
});

const textResult = await generate(userSimulator, [], {});
