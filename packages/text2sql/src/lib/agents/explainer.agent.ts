import { groq } from '@ai-sdk/groq';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  fragment,
  persona,
  structuredOutput,
  user,
} from '@deepagents/context';

const outputSchema = z.object({
  explanation: z.string().describe('The explanation of the SQL query.'),
});

/**
 * Generates a plain English explanation for a SQL query.
 */
export async function explainSql(
  sql: string,
): Promise<{ explanation: string }> {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `explainer-${crypto.randomUUID()}`,
    userId: 'system',
  });

  context.set(
    persona({
      name: 'explainer',
      role: 'You are an expert SQL tutor.',
      objective:
        'Explain SQL queries in plain English that non-technical users understand',
    }),
    fragment('sql', sql),
    fragment('task', 'Focus on the intent and logic, not the syntax.'),
    user('Explain this SQL query in plain English to a non-technical user.'),
  );

  const explainerOutput = structuredOutput({
    model: groq('openai/gpt-oss-20b'),
    context,
    schema: outputSchema,
  });

  return explainerOutput.generate();
}
