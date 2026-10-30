import type { OpenAIProvider } from '@ai-sdk/openai';

import type { WhatsAppParticipant } from './agent.ts';

/** The five specialists the group is made of; every member runs the same model. */
export default function participants(
  provider: OpenAIProvider,
): WhatsAppParticipant[] {
  const modelId = 'gpt-5.6-terra';
  return [
    {
      name: 'researcher',
      specialty:
        'You contribute evidence, concrete facts, and questions that need research.',
      model: provider(modelId),
    },
    {
      name: 'engineer',
      specialty:
        'You contribute technical feasibility, architecture, and implementation consequences.',
      model: provider(modelId),
    },
    {
      name: 'product',
      specialty:
        'You contribute user needs, product scope, adoption, and business value.',
      model: provider(modelId),
    },
    {
      name: 'critic',
      specialty:
        'You contribute contradictions, risks, missing assumptions, and failure modes.',
      model: provider(modelId),
    },
    {
      name: 'creative',
      specialty:
        'You contribute useful alternatives and ideas that the others are unlikely to surface.',
      model: provider(modelId),
    },
  ];
}
