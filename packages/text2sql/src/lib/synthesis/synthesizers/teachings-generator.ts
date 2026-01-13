import type { AgentModel } from '@deepagents/agent';
import { type ContextFragment, XmlRenderer } from '@deepagents/context';

import { toTeachings } from '../../agents/teachables.agent.ts';

export interface TeachingsGeneratorOptions {
  context?: string;
  model?: AgentModel;
  maxRetries?: number;
}

/**
 * Generate domain-specific teachings from database schema.
 * Analyzes the schema to generate teachings that improve SQL generation accuracy.
 * Teachings include domain vocabulary, SQL patterns, guardrails, and examples
 * that help the SQL generator understand the domain and produce semantically
 * correct queries.
 *
 * @param schemaFragments - Schema fragments from adapter.introspect()
 * @param options - Generation options including context, model, and maxRetries
 * @returns Array of teachings including vocabulary, patterns, and guardrails
 */
export async function generateTeachings(
  schemaFragments: ContextFragment[],
  options?: TeachingsGeneratorOptions,
): Promise<ContextFragment[]> {
  const schema = new XmlRenderer().render(schemaFragments);
  const maxRetries = options?.maxRetries ?? 3;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await toTeachings(
        { schema, context: options?.context },
        { model: options?.model },
      );
    } catch (error) {
      lastError = error as Error;
      const isRetryable =
        lastError.message.includes('parse') ||
        lastError.message.includes('schema') ||
        lastError.message.includes('No object generated') ||
        lastError.name.includes('AI_');
      if (!isRetryable) {
        throw lastError;
      }
    }
  }

  throw lastError;
}
