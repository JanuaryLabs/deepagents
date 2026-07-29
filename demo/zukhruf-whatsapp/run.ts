import { openai } from '@ai-sdk/openai';

import { WhatsAppGroup } from './whatsapp.ts';

const message =
  'I am considering launching a local-first AI product for small businesses. What should I think about first?';

console.log('Zukhruf WhatsApp group\n');

await using group = await WhatsAppGroup.create({
  userId: process.env.USER ?? 'local',
  participants: [
    {
      name: 'researcher',
      specialty:
        'You contribute evidence, concrete facts, and questions that need research.',
      model: openai('gpt-5.6-terra'),
    },
    {
      name: 'engineer',
      specialty:
        'You contribute technical feasibility, architecture, and implementation consequences.',
      model: openai('gpt-5.6-terra'),
    },
    {
      name: 'product',
      specialty:
        'You contribute user needs, product scope, adoption, and business value.',
      model: openai('gpt-5.6-terra'),
    },
    {
      name: 'critic',
      specialty:
        'You contribute contradictions, risks, missing assumptions, and failure modes.',
      model: openai('gpt-5.6-terra'),
    },
    {
      name: 'creative',
      specialty:
        'You contribute useful alternatives and ideas that the others are unlikely to surface.',
      model: openai('gpt-5.6-terra'),
    },
  ],
  onMessage: ({ author, content }) => {
    console.log(`${author}: ${content}\n`);
  },
});

await group.send(message);
