import type { AgentModel } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import { toTeachings } from '../../agents/teachables.agent.ts';
import type { Teachables } from '../../teach/teachables.ts';

export interface TeachingsGeneratorOptions {
  context?: string;
  model?: AgentModel;
}
/**
 * TeachingsGenerator - Generate domain-specific teachings from database schema.
 *
 * Analyzes the schema to generate teachings that improve SQL generation accuracy.
 * Teachings include domain vocabulary, SQL patterns, guardrails, and examples
 * that help the SQL generator understand the domain and produce semantically
 * correct queries.
 */
export class TeachingsGenerator {
  /**
   * @param adapter - Database adapter for schema introspection
   * @param options - Generation options including context and model
   */
  constructor(
    private adapter: Adapter,
    private options?: TeachingsGeneratorOptions,
  ) {}

  /**
   * Generates domain-specific teachings by analyzing the database schema.
   * Retries on transient generation errors up to maxRetries attempts.
   * @param maxRetries - Maximum retry attempts for transient failures
   * @returns Array of teachings including vocabulary, patterns, and guardrails
   */
  async generate(maxRetries = 3): Promise<Teachables[]> {
    const schema = await this.adapter.introspect();

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await toTeachings(
          {
            schema,
            context: this.options?.context,
          },
          { model: this.options?.model },
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
}
