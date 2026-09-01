import { expect, it } from 'vitest';
import { z } from 'zod';

import {
  type ComponentRegistry,
  serializeToolsRegistry,
} from '@deepagents/react-genai';

it('serializes only model-facing client tool fields', () => {
  const registry = {
    ask_user_question: {
      component: () => null,
      description: 'Ask the user a question',
      inputSchema: z.object({ question: z.string() }),
      requiresUserInput: true,
      static: false,
    },
  } satisfies ComponentRegistry;

  expect(serializeToolsRegistry(registry)).toEqual({
    ask_user_question: {
      description: 'Ask the user a question',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: { question: { type: 'string' } },
        required: ['question'],
        type: 'object',
      },
    },
  });
});
