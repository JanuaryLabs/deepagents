import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import z from 'zod';

import { type AgentModel, agent, generate, user } from '@deepagents/agent';

import type { Adapter } from '../adapters/adapter.ts';
import {
  type Teachables,
  persona,
  toInstructions,
} from '../teach/teachables.ts';

type SqlGeneratorState = {
  // FIXME: this should not be here after creating the context package
  introspection: string;
  teachings: string;
};

type SqlGeneratorOutput =
  | { sql: string; reasoning?: string }
  | { error: string };

/**
 * Agent that generates SQL queries from introspection and natural language questions.
 * Used for creating synthetic training data for text-to-SQL models.
 */
/** Temperature progression for retries: deterministic first, then increasingly exploratory */
const RETRY_TEMPERATURES = [0, 0.2, 0.3];

const sqlQueryAgent = agent<SqlGeneratorOutput, SqlGeneratorState>({
  name: 'text2sql',
  model: groq('openai/gpt-oss-20b'),
  logging: process.env.AGENT_LOGGING === 'true',
  output: z.union([
    z.object({
      sql: z.string().describe('The SQL query that answers the question'),
      reasoning: z
        .string()
        .optional()
        .describe('The reasoning steps taken to generate the SQL'),
    }),
    z.object({
      error: z
        .string()
        .describe(
          'Error message explaining why the question cannot be answered with the given schema',
        ),
    }),
  ]),
  prompt: (state) => {
    return `
    ${state?.teachings || ''}
    ${state?.introspection || ''}
  `;
  },
});

/** Extract SQL from markdown fenced code block if present */
function extractSql(output: string): string {
  const match = output.match(/```sql\n?([\s\S]*?)```/);
  return match ? match[1].trim() : output.trim();
}

export type GenerateSqlResult =
  | { success: true; sql: string }
  | { success: false; error: string; isUnanswerable?: boolean };

export type GenerateSqlParams = {
  input: string;
  model: AgentModel;
  temperature: number;
  introspection: string;
  instructions: Teachables[];
  previousError?: string;
};

type StepResult =
  | { ok: true; sql: string }
  | { ok: false; error: string; isUnanswerable?: boolean };

/**
 * Generate SQL from natural language using the SQL agent.
 * Handles JSON validation errors from the API by returning an error result.
 */
async function generateSql(
  params: GenerateSqlParams,
): Promise<GenerateSqlResult> {
  const {
    input,
    model,
    temperature,
    introspection,
    instructions,
    previousError,
  } = params;

  const agentInstance = sqlQueryAgent.clone({
    model: wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { temperature, topP: 1 },
      }),
    }),
  });

  const messages = previousError
    ? [
        user(input),
        user(
          `<validation_error>Your previous SQL query had the following error: ${previousError}. Please fix the query.</validation_error>`,
        ),
      ]
    : [user(input)];

  try {
    const { experimental_output: output } = await generate(
      agentInstance,
      messages,
      {
        teachings: toInstructions(
          'instructions',
          persona({
            name: 'Freya',
            role: 'You are an expert SQL query generator. You translate natural language questions into precise, efficient SQL queries based on the provided database schema.',
          }),
          ...instructions,
        ),
        introspection,
      },
    );

    // Handle error responses (question is unanswerable with given schema)
    if ('error' in output) {
      return { success: false, error: output.error, isUnanswerable: true };
    }

    return { success: true, sql: extractSql(output.sql) };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('Failed to validate JSON') ||
        error.message.includes('response did not match schema'))
    ) {
      return {
        success: false,
        error: `Schema validation failed: ${error.message}`,
      };
    }
    throw error;
  }
}

/**
 * Exported object for mockability in tests.
 * Use `mock.method(sqlGenerators, 'generateSql', ...)` to mock.
 */
export const sqlGenerators = {
  generateSql,
};

/**
 * Generate SQL and validate it in a single step.
 * Returns a unified result for both generation and validation errors.
 */
async function generateAndValidate(
  options: ToSqlOptions,
  temperature: number,
  previousError?: string,
): Promise<StepResult> {
  const result = await sqlGenerators.generateSql({
    input: options.input,
    model: options.model ?? sqlQueryAgent.model,
    temperature,
    introspection: options.introspection,
    instructions: options.instructions,
    previousError,
  });

  if (!result.success) {
    return {
      ok: false,
      error: result.error,
      isUnanswerable: result.isUnanswerable,
    };
  }

  const validationError = await options.adapter.validate(result.sql);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  return { ok: true, sql: result.sql };
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
 * Also retries on API-level JSON validation errors from the model.
 * Does NOT retry when the question is unanswerable (intentional error response).
 */
export async function toSql(options: ToSqlOptions): Promise<ToSqlResult> {
  const { maxRetries = 3 } = options;
  const errors: string[] = [];

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const temperature = RETRY_TEMPERATURES[attempt - 1] ?? 0.3;
    const result = await generateAndValidate(
      options,
      temperature,
      errors.at(-1),
    );

    if (result.ok) {
      return {
        sql: result.sql,
        attempts: attempt,
        errors: errors.length ? errors : undefined,
      };
    }

    // Don't retry if the question is unanswerable - it's an intentional error
    if (result.isUnanswerable) {
      return { sql: '', attempts: attempt, errors: [result.error] };
    }

    errors.push(result.error);
  }

  return { sql: '', attempts: maxRetries, errors };
}
