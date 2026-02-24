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
import dedent from 'dedent';
import pRetry from 'p-retry';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  fragment,
  persona,
  policy,
  structuredOutput,
  user,
} from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';
import { SQLValidationError, UnanswerableSQLError } from './exceptions.ts';

export interface ToSqlOptions {
  /** The natural language input to convert to SQL */
  input: string;
  /** Database adapter for validation */
  adapter: Adapter;
  /** Context fragments (schema + instructions/teachings) */
  fragments: ContextFragment[];
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
const SQL_AGENT_ROLE = 'Expert SQL query generator.';
const SQL_AGENT_OBJECTIVE = 'Generate precise SQL grounded in provided schema.';

const SQL_AGENT_POLICIES: ContextFragment[] = [
  fragment(
    'schema_mapping',
    policy({
      rule: 'Translate natural language into precise SQL grounded in available schema entities.',
    }),
    policy({
      rule: 'Before returning an error, perform a schema-grounded self-check: identify core intent, draft best-effort SQL, then verify it uses only existing tables/columns.',
    }),
    policy({
      rule: 'Return unanswerable only if that self-check confirms no valid SQL can express the required intent without inventing schema elements.',
    }),
    // policy({
    //   rule: 'Prefer a best-effort valid SQL query when entities can be reasonably inferred from table or column names.',
    // }),
    // policy({
    //   rule: 'Use lexical normalization (singular/plural, paraphrases, role synonyms, and minor wording differences) to align question terms with schema names.',
    // }),
    // policy({
    //   rule: 'Decompose noun phrases into core entity and qualifiers, and map the core entity first.',
    // }),
    // policy({
    //   rule: 'Do not require every descriptive word to map to a separate schema field when the core entity match is unambiguous.',
    // }),
    // policy({
    //   rule: 'For phrases like "X of Y", treat Y as contextual (non-blocking) when Y has no mapped schema field and the question does not ask to filter/group/select by Y explicitly.',
    // }),
    // policy({
    //   rule: 'Treat unmatched qualifiers as blockers only when they are restrictive constraints (specific values, comparisons, or conditions that change row eligibility).',
    // }),
    // hint('Preserve schema spelling exactly, including typos in column names.'),
  ),
  // fragment(
  //   'unanswerable_gate',
  //   workflow({
  //     task: 'Unanswerable decision',
  //     steps: [
  //       'Identify the core intent (metric/projection and required filters).',
  //       'Attempt schema-grounded mapping for the core intent before considering error.',
  //       'If a valid SELECT can answer the core intent without inventing schema entities, return SQL.',
  //       'Return unanswerable only when required information cannot be mapped to any available table or column.',
  //     ],
  //   }),
  //   policy({
  //     rule: 'Do not reject a question as unanswerable when requested information can be derived by filtering, joining, grouping, counting, set operations, or sorting on available columns.',
  //   }),
  // ),
  // fragment(
  //   'query_shape_preferences',
  //   hint(
  //     'Prefer explicit INNER JOINs over LEFT JOINs unless the question requires unmatched rows.',
  //   ),
  //   hint(
  //     'Prefer direct joins over dropping join constraints or using weaker alternatives.',
  //   ),
  //   hint('Use DISTINCT only when uniqueness is explicitly requested.'),
  //   hint(
  //     'For superlatives over grouped entities (most/least/highest/lowest by group), prefer GROUP BY with ORDER BY aggregate and LIMIT 1.',
  //   ),
  //   hint(
  //     'For average/count conditions per entity, prefer GROUP BY with HAVING aggregate predicates over row-level WHERE predicates.',
  //   ),
  //   hint(
  //     'For "both" conditions across two criteria, prefer INTERSECT when selecting shared values.',
  //   ),
  //   hint(
  //     'For "A or B" retrieval across criteria, prefer UNION when combining two qualifying sets.',
  //   ),
  //   hint(
  //     'For "never" constraints against related records, prefer NOT IN or EXCEPT against the disqualifying set.',
  //   ),
  //   hint(
  //     'Use equality predicates for exact values unless the question asks for pattern matching.',
  //   ),
  //   hint(
  //     'Keep numeric literals unquoted when they are purely numeric tokens in the question.',
  //   ),
  // ),
  // fragment(
  //   'sql_minimality',
  //   guardrail({
  //     rule: 'Never hallucinate tables or columns.',
  //     reason: 'Schema fidelity is required.',
  //     action: 'Use only available schema entities.',
  //   }),
  //   guardrail({
  //     rule: 'Prefer the minimal query over transformed expressions.',
  //     reason:
  //       'Unnecessary transformations reduce correctness and add avoidable complexity.',
  //     action:
  //       'Do not add date parsing, substring extraction, derived projections, or extra selected columns unless explicitly requested or required by schema mismatch.',
  //   }),
  // ),
];

/** Extract SQL from markdown fenced code block if present */
function extractSql(output: string): string {
  const match = output.match(/```sql\n?([\s\S]*?)```/);
  return match ? match[1].trim() : output.trim();
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
          role: SQL_AGENT_ROLE,
          objective: SQL_AGENT_OBJECTIVE,
          // role: `You are a data science expert that provides well-reasoned and detailed responses.`,
          // objective: `Your task is to understand the schema and generate a valid SQL query to answer the question. You first think about the reasoning process as an internal monologue and then provide the user with the answer.`,
        }),
        ...SQL_AGENT_POLICIES,
        ...options.fragments,
      );

      // Add user message(s)
      if (errors.length) {
        const lastError = errors.at(-1);
        context.set(
          user(dedent`
            Answer the following question with the SQL code. Use the piece of evidence and base your answer on the database schema.
Given the question, the evidence and the database schema, return the SQL script that addresses the question.

Question: ${options.input}
`),
          UnanswerableSQLError.isInstance(lastError)
            ? user(
                `<retry_instruction>Your previous response marked the task as unanswerable. Re-evaluate using best-effort schema mapping. If the core intent is answerable with existing tables/columns, return SQL. Return error only when required core intent cannot be mapped without inventing schema elements.</retry_instruction>`,
              )
            : user(
                `<validation_error>Your previous SQL query had the following error: ${lastError?.message}. Please fix the query.</validation_error>`,
              ),
        );
      } else {
        context.set(
          user(dedent`
            Answer the following question with the SQL code. Use the piece of evidence and base your answer on the database schema.
Given the question, the evidence and the database schema, return the SQL script that addresses the question.

Question: ${options.input}
`),
        );
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
      // console.log(await context.render(new XmlRenderer()));
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

      const finalizeSql = async (rawSql: string): Promise<ToSqlResult> => {
        const sql = options.adapter.format(extractSql(rawSql));

        const validationError = await options.adapter.validate(sql);
        if (validationError) {
          throw new SQLValidationError(validationError);
        }

        return {
          attempts,
          sql,
          errors: errors.length ? errors.map(formatErrorMessage) : undefined,
        };
      };

      // Handle error responses (question is unanswerable with given schema)
      if ('error' in output) {
        context.set(
          user(
            '<best_effort_fallback>Do not return unanswerable. Produce the best valid SQL query that answers the core intent using only available schema entities.</best_effort_fallback>',
          ),
        );
        const forcedSqlOutput = structuredOutput({
          model,
          context,
          schema: z.object({
            sql: z
              .string()
              .describe(
                'Best-effort SQL query that answers the core intent using only available schema entities.',
              ),
            reasoning: z
              .string()
              .describe('Reasoning steps for best-effort schema mapping.'),
          }),
        });

        try {
          const forced = await forcedSqlOutput.generate();
          return await finalizeSql(forced.sql);
        } catch (error) {
          if (
            SQLValidationError.isInstance(error) ||
            APICallError.isInstance(error) ||
            JSONParseError.isInstance(error) ||
            TypeValidationError.isInstance(error) ||
            NoObjectGeneratedError.isInstance(error) ||
            NoOutputGeneratedError.isInstance(error) ||
            NoContentGeneratedError.isInstance(error)
          ) {
            throw error;
          }
          throw new UnanswerableSQLError(output.error);
        }
      }

      return await finalizeSql(output.sql);
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
        // Retry one time when the model marks query as unanswerable to recover from false positives.
        if (UnanswerableSQLError.isInstance(context.error)) {
          return context.attemptNumber === 1;
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
        // console.log(
        //   `Attempt ${context.attemptNumber} failed. There are ${context.retriesLeft} retries left.`,
        // );
        // console.dir(context.error, { depth: null });
        errors.push(context.error);
      },
    },
  );
}
