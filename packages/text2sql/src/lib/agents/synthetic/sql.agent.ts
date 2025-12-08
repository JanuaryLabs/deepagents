import { groq } from '@ai-sdk/groq';
import z from 'zod';

import { type AgentModel, agent, generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import {
  type Teachables,
  persona,
  toInstructions,
} from '../../teach/teachables.ts';

type SqlGeneratorState = {
  // FIXME: this should not be here after creating the context package
  introspection: string;
  teachings: string;
};

type SqlGeneratorOutput = {
  sql: string;
};

/**
 * Agent that generates SQL queries from introspection and natural language questions.
 * Used for creating synthetic training data for text-to-SQL models.
 */
export const sqlQueryAgent = agent<SqlGeneratorOutput, SqlGeneratorState>({
  name: 'text2sql',
  model: groq('openai/gpt-oss-20b'),
  logging: process.env.AGENT_LOGGING === 'true',
  output: z.object({
    sql: z.string().describe('The SQL query that answers the question'),
  }),
  prompt: (state) => {
    return `
    ${state?.teachings || ''}
    ${state?.introspection || ''}
    <output>
CRITICAL: Your final response must be ONLY the executable SQL query.
- No markdown code blocks (no \`\`\` or \`\`\`sql)
- No explanations, commentary, or preamble
- No "Here is the query" or similar text
- No execution results or data summaries
- Do NOT execute the query - just generate and return it
- Just the raw SQL statement that can be copied and run directly
</output>
  `;
  },
});

/** Extract SQL from markdown fenced code block if present */
function extractSql(output: string): string {
  const match = output.match(/```sql\n?([\s\S]*?)```/);
  return match ? match[1].trim() : output.trim();
}

export interface ToSqlOptions {
  /** The natural language input to convert to SQL */
  input: string;
  /** Database adapter for validation */
  adapter: Adapter;
  /** Introspection/schema context */
  introspection: string;
  /** Instructions/teachings to include */
  instructions: Teachables[];
  /** Optional model override */
  model?: AgentModel;
  /** Maximum retry attempts on validation failure (default: 3) */
  maxRetries?: number;
}

export interface ToSqlResult {
  /** The generated SQL query */
  sql: string;
  /** Number of attempts made */
  attempts: number;
  /** Validation errors encountered (if any retries occurred) */
  errors?: string[];
}

/**
 * Generate SQL from natural language with post-generation validation.
 * Retries generation if validation fails, including the error in the retry prompt.
 */
export async function toSql(options: ToSqlOptions): Promise<ToSqlResult> {
  const {
    input,
    adapter,
    introspection,
    instructions,
    model,
    maxRetries = 3,
  } = options;

  const errors: string[] = [];
  let attempts = 0;
  let sql = '';

  const agentInstance = sqlQueryAgent.clone({
    model,
  });

  do {
    attempts++;

    // Build messages: include previous errors if this is a retry
    const messages =
      errors.length > 0
        ? [
            user(input),
            user(
              `<validation_error>Your previous SQL query had the following error: ${errors[errors.length - 1]}. Please fix the query.</validation_error>`,
            ),
          ]
        : [user(input)];

    const { text } = await generate(agentInstance, messages, {
      teachings: toInstructions(
        'instructions',
        persona({
          name: 'Freya',
          role: 'You are an expert SQL query generator. You translate natural language questions into precise, efficient SQL queries based on the provided database schema.',
        }),
        ...instructions,
      ),
      adapter,
      introspection,
    });

    sql = extractSql(text);

    // Validate the generated SQL
    const validationResult = await adapter.validate(sql);

    if (validationResult === undefined || validationResult === null) {
      // Valid SQL (no error returned)
      return {
        sql,
        attempts,
        errors: errors.length > 0 ? errors : undefined,
      };
    }

    // Validation failed, store error and retry
    errors.push(validationResult);
  } while (attempts < maxRetries);

  // All retries exhausted, return the last generated SQL with errors
  return {
    sql,
    attempts,
    errors,
  };
}
