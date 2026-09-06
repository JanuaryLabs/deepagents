import { openai } from '@ai-sdk/openai';

import type { WhatsAppParticipant } from './agent.ts';

/** The five specialists the group is made of; every member runs the same model. */
export default [
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
] satisfies WhatsAppParticipant[];
