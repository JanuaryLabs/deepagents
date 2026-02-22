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
import pRetry from 'p-retry';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  persona,
  structuredOutput,
  user,
} from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';

export interface ToSqlOptions {
  /** The natural language input to convert to SQL */
  input: string;
  /** Database adapter for validation */
  adapter: Adapter;
  /** Schema fragments from adapter introspection */
  schemaFragments: ContextFragment[];
  /** Instructions/teachings to include */
  instructions: ContextFragment[];
  /** Optional model override */
  model: AgentModel;
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

/** Temperature progression for retries: deterministic first, then increasingly exploratory */
const RETRY_TEMPERATURES = [0, 0.2, 0.3];

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
      const context = new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: `sql-gen-${crypto.randomUUID()}`,
        userId: 'system',
      });

      context.set(
        persona({
          name: 'Freya',
          role: 'You are an expert SQL query generator. You translate natural language questions into precise, efficient SQL queries based on the provided database schema.',
          objective:
            'Translate natural language questions into precise, efficient SQL queries',
        }),
        ...options.instructions,
        ...options.schemaFragments,
      );

      // Add user message(s)
      if (errors.length) {
        context.set(
          user(options.input),
          user(
            `<validation_error>Your previous SQL query had the following error: ${errors.at(-1)?.message}. Please fix the query.</validation_error>`,
          ),
        );
      } else {
        context.set(user(options.input));
      }

      // Create structured output with schema
      const temperature =
        RETRY_TEMPERATURES[attemptNumber - 1] ??
        RETRY_TEMPERATURES[RETRY_TEMPERATURES.length - 1];
      const baseModel = options.model ?? groq('openai/gpt-oss-20b');
      const model = wrapLanguageModel({
        model: baseModel,
        middleware: defaultSettingsMiddleware({ settings: { temperature } }),
      });
      const sqlOutput = structuredOutput({
        model: model,
        context,
        schema: z.object({
          result: z.union([
            z.object({
              sql: z
                .string()
                .describe('The SQL query that answers the question'),
              reasoning: z
                .string()
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
        }),
      });

      const { result: output } = await sqlOutput.generate();

      // Handle error responses (question is unanswerable with given schema)
      if ('error' in output) {
        throw new UnanswerableSQLError(output.error);
      }

      const sql = options.adapter.format(extractSql(output.sql));

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

function isModelUnavailableError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const responseBody = (error.responseBody ?? '').toLowerCase();
  const is404ModelError =
    error.statusCode === 404 &&
    (message.includes('model') || responseBody.includes('model_not_found'));
  const errorCode =
    typeof error.data === 'object' &&
    error.data !== null &&
    'error' in error.data &&
    typeof error.data.error === 'object' &&
    error.data.error !== null &&
    'code' in error.data.error &&
    typeof error.data.error.code === 'string'
      ? error.data.error.code.toLowerCase()
      : undefined;

  return (
    is404ModelError ||
    errorCode === 'model_not_found' ||
    responseBody.includes('"code":"model_not_found"') ||
    (message.includes('model') &&
      message.includes('does not exist or you do not have access to it'))
  );
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
        // Don't retry if the selected model is unavailable
        if (isModelUnavailableError(context.error)) {
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
        console.log(
          `Attempt ${context.attemptNumber} failed. There are ${context.retriesLeft} retries left.`,
        );
        // console.dir(context.error, { depth: null });
        errors.push(context.error);
      },
    },
  );
}
