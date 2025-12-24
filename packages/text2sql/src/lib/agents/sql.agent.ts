import { groq } from '@ai-sdk/groq';
import {
  APICallError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  TypeValidationError,
  defaultSettingsMiddleware,
  wrapLanguageModel,
} from 'ai';
import { Console } from 'node:console';
import { createWriteStream } from 'node:fs';
import pRetry from 'p-retry';
import z from 'zod';

import {
  type AgentModel,
  agent,
  generate,
  toOutput,
  user,
} from '@deepagents/agent';

import type { Adapter } from '../adapters/adapter.ts';
import {
  type Teachables,
  persona,
  toInstructions,
} from '../teach/teachables.ts';

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

const logger = new Console({
  stdout: createWriteStream('./sql-agent.log', { flags: 'a' }),
  stderr: createWriteStream('./sql-agent-error.log', { flags: 'a' }),
  inspectOptions: { depth: null },
});

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

const marker = Symbol('SQLValidationError');
/**
 * Error thrown when SQL validation fails.
 */
export class SQLValidationError extends Error {
  [marker]: true;
  constructor(message: string) {
    super(message);
    this.name = 'SQLValidationError';
    this[marker] = true;
  }
  static isInstance(error: unknown): error is SQLValidationError {
    return error instanceof SQLValidationError && error[marker] === true;
  }
}

/**
 * Error thrown when the question cannot be answered with the given schema.
 */
export class UnanswerableSQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnanswerableSQLError';
  }
  static isInstance(error: unknown): error is UnanswerableSQLError {
    return error instanceof UnanswerableSQLError;
  }
}

export async function toSql(options: ToSqlOptions): Promise<ToSqlResult> {
  const { maxRetries = 3 } = options;

  return withRetry(
    async (attemptNumber, errors, attempts) => {
      const agentInstance = sqlQueryAgent.clone({
        model: wrapLanguageModel({
          model: options.model ?? sqlQueryAgent.model,
          middleware: defaultSettingsMiddleware({
            settings: {
              temperature: RETRY_TEMPERATURES[attemptNumber - 1] ?? 0.3,
              topP: 1,
            },
          }),
        }),
      });

      const messages = errors.length
        ? [
            user(options.input),
            user(
              `<validation_error>Your previous SQL query had the following error: ${errors.at(-1)?.message}. Please fix the query.</validation_error>`,
            ),
          ]
        : [user(options.input)];

      const output = await toOutput(
        generate(agentInstance, messages, {
          introspection: options.introspection,
          teachings: toInstructions(
            'instructions',
            persona({
              name: 'Freya',
              role: 'You are an expert SQL query generator. You translate natural language questions into precise, efficient SQL queries based on the provided database schema.',
            }),
            ...options.instructions,
          ),
        }),
      );

      // Handle error responses (question is unanswerable with given schema)
      if ('error' in output) {
        throw new UnanswerableSQLError(output.error);
      }

      const sql = extractSql(output.sql);

      // Validate the generated SQL
      const validationError = await options.adapter.validate(sql);
      if (validationError) {
        throw new SQLValidationError(validationError);
      }

      return {
        attempts,
        sql,
        errors: errors.length ? errors.map(formatErrorMessage) : undefined,
      };
    },
    { retries: maxRetries - 1 },
  );
}

function formatErrorMessage(error: Error) {
  if (APICallError.isInstance(error)) {
    if (error.message.startsWith('Failed to validate JSON')) {
      return `Schema validation failed: ${error.message}`;
    }
    return error.message;
  }
  if (SQLValidationError.isInstance(error)) {
    return `SQL Validation Error: ${error.message}`;
  }
  return error.message;
}

async function withRetry<T>(
  computation: (
    attemptNumber: number,
    errors: Error[],
    attempts: number,
  ) => Promise<T>,
  options: { retries: number } = { retries: 3 },
) {
  const errors: Error[] = [];
  let attempts = 0;
  return pRetry(
    (attemptNumber) => {
      return computation(attemptNumber, errors, ++attempts);
    },
    {
      retries: options.retries,
      shouldRetry: (context) => {
        // Don't retry if unanswerable - it's intentional
        if (UnanswerableSQLError.isInstance(context.error)) {
          return false;
        }
        // Retry on validation errors
        if (SQLValidationError.isInstance(context.error)) {
          return true;
        }
        console.log({
          NoObjectGeneratedError: NoObjectGeneratedError.isInstance(
            context.error,
          ),
          NoOutputGeneratedError: NoOutputGeneratedError.isInstance(
            context.error,
          ),
          APICallError: APICallError.isInstance(context.error),
          JSONParseError: JSONParseError.isInstance(context.error),
          TypeValidationError: TypeValidationError.isInstance(context.error),
          NoContentGeneratedError: NoContentGeneratedError.isInstance(
            context.error,
          ),
        });
        // Retry on AI SDK errors
        return (
          APICallError.isInstance(context.error) ||
          JSONParseError.isInstance(context.error) ||
          TypeValidationError.isInstance(context.error) ||
          NoObjectGeneratedError.isInstance(context.error) ||
          NoOutputGeneratedError.isInstance(context.error) ||
          NoContentGeneratedError.isInstance(context.error)
        );
      },
      onFailedAttempt(context) {
        logger.error(`toSQL`, context.error);
        console.log(
          `Attempt ${context.attemptNumber} failed. There are ${context.retriesLeft} retries left.`,
        );
        // console.dir(context.error, { depth: null });
        errors.push(context.error);
      },
    },
  );
}
