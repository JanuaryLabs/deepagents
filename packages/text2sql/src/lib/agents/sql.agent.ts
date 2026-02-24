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
  example,
  fragment,
  guardrail,
  hint,
  persona,
  policy,
  structuredOutput,
  user,
  workflow,
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
const RETRY_TEMPERATURES = [0, 0.4, 0.8];
const SQL_AGENT_ROLE = 'Expert SQL query generator.';
const SQL_AGENT_OBJECTIVE = 'Generate precise SQL grounded in provided schema.';

const SQL_AGENT_POLICIES: ContextFragment[] = [
  fragment(
    'schema_mapping',
    policy({
      rule: 'Translate natural language into precise SQL grounded in available schema entities.',
    }),
    hint('Preserve schema spelling exactly, including typos in column names.'),
  ),
  fragment(
    'projection_minimality',
    policy({
      rule: 'Return only columns requested by the question; do not add helper columns unless explicitly requested.',
    }),
    policy({
      rule: 'For requests of the form "X sorted/ordered by Y", project X only unless Y is explicitly requested as an output field.',
    }),
    policy({
      rule: 'Prefer selecting schema columns directly without derived expressions when direct selection answers the request.',
    }),
    hint(
      'Do not include ORDER BY, GROUP BY, or JOIN helper columns in SELECT output unless the question explicitly asks for them.',
    ),
    policy({
      rule: 'Use DISTINCT only when uniqueness is explicitly requested (for example distinct/unique/different/no duplicates).',
    }),
    hint(
      'Do not infer DISTINCT from generic wording such as "some", plural nouns, or entity-set phrasing; for transactional/attendance-style tables, default to raw rows unless uniqueness is explicitly requested.',
    ),
  ),
  fragment(
    'date_transform_safety',
    policy({
      rule: 'Do not assume VARCHAR/TEXT values are parseable dates. Avoid date extraction functions on text columns by default.',
    }),
    policy({
      rule: 'Use date-part extraction only when both conditions hold: the question explicitly asks for transformation and schema values require transformation to produce that unit.',
    }),
    hint(
      'Do not apply SUBSTR, STRFTIME, DATE_PART, YEAR, or similar extraction functions unless the question explicitly asks for transformation and schema values require it.',
    ),
    hint(
      'If a column already represents the requested concept (for example a stored year-like value), use the column as-is.',
    ),
  ),
  fragment(
    'sql_minimality',
    guardrail({
      rule: 'Never hallucinate tables or columns.',
      reason: 'Schema fidelity is required.',
      action: 'Use only available schema entities.',
    }),
    guardrail({
      rule: 'Avoid unnecessary transformations and derived projections.',
      reason:
        'Extra transformations frequently change semantics and reduce correctness.',
      action:
        'Do not add date parsing, substring extraction, or derived columns unless explicitly required by the question or schema.',
    }),
  ),
  fragment(
    'preflight_checklist',
    workflow({
      task: 'Final SQL preflight before returning output',
      steps: [
        'Verify selected columns match the question and remove unrequested helper projections.',
        'If aggregate values are used only for ranking/filtering, keep them out of SELECT unless explicitly requested.',
        'Prefer raw schema columns over derived expressions when raw columns already satisfy the request.',
        'If a candidate query uses STRFTIME, SUBSTR, DATE_PART, YEAR, or similar extraction on text-like columns, remove that transformation unless explicitly required by the question.',
        'Return only schema-grounded SQL using existing tables and columns.',
      ],
    }),
  ),
  fragment(
    'set_semantics',
    policy({
      rule: 'For questions asking where both condition A and condition B hold over an attribute, compute the intersection of qualifying sets for that attribute.',
    }),
    policy({
      rule: 'Do not force the same entity instance to satisfy both conditions unless the question explicitly requests the same person/row/entity.',
    }),
    hint(
      'Prefer INTERSECT (or logically equivalent set-based shape) over requiring the same physical row/entity to satisfy both conditions unless explicitly requested.',
    ),
    hint(
      'When two conditions describe different row groups whose shared attribute is requested, build each group separately and intersect the attribute values.',
    ),
    hint(
      'Do not collapse cross-group conditions into a single-row AND predicate when the intent is shared values across groups.',
    ),
    policy({
      rule: 'If two predicates on the same field cannot both be true for one row, do not combine them with AND; use set operations across separate filtered subsets when shared values are requested.',
    }),
  ),
  fragment(
    'predicate_column_alignment',
    policy({
      rule: 'Match literal values to semantically compatible columns. Do not compare descriptive names to identifier columns.',
    }),
    hint(
      'When a filter value is a descriptive label (for example a department name), join through the lookup table and filter on its name/title column, not on *_id columns.',
    ),
    hint(
      'When relation roles are explicit in wording (for example host/home/source/destination), prefer foreign keys with matching role qualifiers over generic similarly named columns.',
    ),
    policy({
      rule: 'When multiple foreign-key candidates exist, select the column whose qualifier best matches the relationship described in the question.',
    }),
    policy({
      rule: 'For hosting/held semantics, prefer host_* relationship columns when available over generic *_id alternatives.',
    }),
    hint(
      'Interpret wording like "held/hosted a competition or event" as a hosting relationship and map to host_* foreign keys when present.',
    ),
    policy({
      rule: 'Do not compare descriptive labels or names to *_id columns; join to the table containing the descriptive field and filter there.',
    }),
    policy({
      rule: 'Keep numeric identifiers unquoted when used as numeric equality filters unless schema indicates text identifiers.',
    }),
    policy({
      rule: 'When filtering by a descriptive label value and a related table exposes a corresponding *_name or title column, join to that table and filter on the descriptive column.',
    }),
  ),
  fragment(
    'ordering_semantics',
    policy({
      rule: 'Respect explicit sort direction terms. If direction is not specified, use ascending order unless a superlative intent (most/least/highest/lowest) implies direction.',
    }),
    policy({
      rule: 'When ranking categories by frequency, use COUNT for ordering but keep output focused on requested category fields unless counts are explicitly requested.',
    }),
    policy({
      rule: 'Do not use DESC unless descending direction is explicit or a superlative intent requires descending ranking.',
    }),
    policy({
      rule: 'For "most common/frequent <attribute>" requests, return the attribute value(s) only; use counts only for ordering/filtering unless the question explicitly asks to return counts.',
    }),
    hint(
      'Use DESC with LIMIT 1 for "most/highest/largest"; use ASC with LIMIT 1 for "least/lowest/smallest".',
    ),
  ),
  fragment(
    'negative_membership_queries',
    policy({
      rule: 'For requests asking entities that did not participate/host/appear in related records, prefer NOT IN or NOT EXISTS against the related foreign-key set.',
    }),
    hint(
      'Map role-bearing relationship columns carefully (for example host_* foreign keys for hosting relationships) instead of generic IDs when role wording is explicit.',
    ),
    hint(
      'For "never had/never exceeded" conditions over history tables, exclude entities via NOT IN/NOT EXISTS against the disqualifying entity-id set (often built with GROUP BY/HAVING MAX(...)).',
    ),
  ),
  fragment(
    'join_completeness',
    policy({
      rule: 'Preserve entity-restricting joins implied by the question. Do not widen results by querying only a broader attribute table when a subset entity table is available.',
    }),
    policy({
      rule: 'If an entity term in the question maps to a table, keep that table in query scope and join to attribute tables rather than dropping the entity table.',
    }),
    hint(
      'If the question targets a specific entity group, include that entity table and its join conditions even when selected columns come from a related table.',
    ),
    hint(
      'When the question names an entity type and a relation table links to that entity via *_id, include the entity table in scope instead of counting only relation rows.',
    ),
    hint(
      'Prefer INNER JOIN by default; use LEFT JOIN only when the question explicitly requests including unmatched rows or zero-related entities.',
    ),
  ),
  fragment(
    'aggregation_exactness',
    policy({
      rule: 'Preserve requested aggregation semantics exactly: use COUNT(*) by default for total rows, use COUNT(DISTINCT ...) only when uniqueness is explicitly requested, and group by stable entity keys when computing per-entity aggregates.',
    }),
    policy({
      rule: 'For questions asking which entity has lowest/highest average of a metric, compute AVG(metric) per entity (GROUP BY entity) and rank those aggregates.',
    }),
    hint(
      'For "how many <entities>" questions over relation records, default to COUNT(*) on qualifying rows unless explicit uniqueness language is present.',
    ),
  ),
  fragment(
    'query_shape_examples',
    example({
      question:
        'List categories ordered by how many records belong to each category.',
      answer:
        'SELECT category FROM records GROUP BY category ORDER BY COUNT(*)',
    }),
    example({
      question:
        'Show labels shared by rows with metric > 100 and rows with metric < 10.',
      answer:
        'SELECT label FROM records WHERE metric > 100 INTERSECT SELECT label FROM records WHERE metric < 10',
    }),
    example({
      question: 'List locations that have not hosted any event.',
      answer:
        'SELECT location_name FROM locations WHERE location_id NOT IN (SELECT host_location_id FROM events)',
    }),
    example({
      question: 'List the most common category across records.',
      answer:
        'SELECT category FROM records GROUP BY category ORDER BY COUNT(*) DESC LIMIT 1',
    }),
  ),
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
          return false;
          // disable retryng here will also disable the forced sql generation fallback.
          // return context.attemptNumber === 0;
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
