/**
 * Chat4 Agent - Question Decomposition Approach
 *
 * This variant breaks down the user's question into semantic components
 * before passing it to the SQL agent. Instead of:
 *   "Which customers bought the most expensive products last quarter?"
 *
 * It passes a decomposition:
 *   - entities: customers, products, purchases
 *   - filters: expensive products, last quarter
 *   - aggregation: most (count? value?)
 *   - output: list of customers
 *
 * This helps the SQL agent understand the different aspects of the question
 * without being told HOW to implement it.
 */
import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, tool, wrapLanguageModel } from 'ai';
import z from 'zod';

import { agent, generate, toState, user } from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import type { Adapter } from '../adapters/adapter.ts';
import type { TeachablesStore } from '../memory/store.ts';
import {
  type Teachables,
  persona,
  toInstructions,
} from '../teach/teachables.ts';

export type Chat4State = {
  /** Database adapter for query execution */
  adapter: Adapter;
  /** Schema introspection XML */
  introspection: string;
  /** Teachings/instructions for SQL generation */
  instructions: Teachables[];
  /** Combined teachings string for the agent prompt */
  teachings: string;
  /** Optional memory store for user teachables */
  memory?: TeachablesStore;
  /** User ID for memory operations */
  userId?: string;
};

/**
 * Schema for question decomposition
 */
const questionDecompositionSchema = z.object({
  originalQuestion: z
    .string()
    .describe('The original question being decomposed'),
  breakdown: z
    .array(z.string())
    .min(1)
    .describe(
      'Semantic breakdown of the question into its component parts. Each part describes an aspect of what is being asked, NOT how to implement it.',
    ),
  entities: z
    .array(z.string())
    .optional()
    .describe(
      'Key entities/concepts mentioned (e.g., customers, orders, products)',
    ),
  filters: z
    .array(z.string())
    .optional()
    .describe(
      'Filtering criteria mentioned (e.g., "last quarter", "above $100")',
    ),
  aggregation: z
    .string()
    .optional()
    .describe(
      'Type of aggregation if any (e.g., "count", "sum", "average", "top N")',
    ),
  ambiguities: z
    .array(z.string())
    .optional()
    .describe('Any ambiguous parts that might need clarification'),
});

type QuestionDecomposition = z.infer<typeof questionDecompositionSchema>;

/**
 * Output schema for the decomposition-aware SQL agent
 */
const decompositionSqlOutputSchema = z.union([
  z.object({
    sql: z
      .string()
      .describe('The SQL query that answers the decomposed question'),
    reasoning: z
      .string()
      .optional()
      .describe('How each breakdown component was addressed'),
  }),
  z.object({
    error: z
      .string()
      .describe('Error message if the question cannot be answered'),
  }),
]);

type DecompositionSqlOutput = z.infer<typeof decompositionSqlOutputSchema>;

/**
 * Internal agent for SQL generation from decomposed questions
 */
const decompositionSqlAgent = agent<DecompositionSqlOutput, Chat4State>({
  name: 'decomposition-sql',
  model: groq('openai/gpt-oss-20b'),
  output: decompositionSqlOutputSchema,
  prompt: (state) => {
    return `
${toInstructions(
  'instructions',
  persona({
    name: 'SQLDecomp',
    role: 'You are an expert SQL query generator. You receive questions broken down into semantic components and generate precise SQL.',
  }),
  ...(state?.instructions || []),
)}
${state?.introspection || ''}

You will receive questions in a decomposed format with:
- breakdown: Semantic parts of the question
- entities: Key concepts mentioned
- filters: Filtering criteria
- aggregation: Type of aggregation needed
- ambiguities: Potentially unclear parts

Address each component of the breakdown in your SQL.
If there are ambiguities, make reasonable assumptions and note them in your reasoning.
`;
  },
});

/**
 * Result from the decomposed query tool
 */
export interface DecomposedQueryResult {
  success: boolean;
  /** The original question */
  question?: string;
  /** How the question was decomposed */
  decomposition?: QuestionDecomposition;
  /** The generated SQL */
  sql?: string;
  /** Query results */
  data?: unknown[];
  /** How breakdown components were addressed */
  reasoning?: string;
  /** Error message if failed */
  error?: string;
  /** Number of generation attempts */
  attempts?: number;
}

/** Temperature progression for retries */
const RETRY_TEMPERATURES = [0, 0.2, 0.3];

const tools = {
  query_with_decomposition: tool({
    description: `Query the database using question decomposition. This tool:
1. Breaks down your question into semantic components (entities, filters, aggregations)
2. Passes the decomposition to the SQL specialist
3. Generates and validates SQL
4. Executes and returns results

This approach helps ensure all aspects of the question are addressed in the query.`,
    inputSchema: z.object({
      question: z.string().min(1).describe('The question to answer.'),
      breakdown: z
        .array(z.string())
        .min(1)
        .describe(
          'Break down the question into its semantic parts. Each part should describe an ASPECT of what is being asked, not instructions. Example for "top customers by revenue last month": ["customers who made purchases", "revenue from those purchases", "time period: last month", "ranking: top by total revenue"]',
        ),
      entities: z
        .array(z.string())
        .optional()
        .describe(
          'Key entities mentioned (e.g., ["customers", "orders", "products"])',
        ),
      filters: z
        .array(z.string())
        .optional()
        .describe('Filter criteria (e.g., ["last month", "status = active"])'),
      aggregation: z
        .string()
        .optional()
        .describe(
          'Aggregation type if any (e.g., "sum revenue", "count orders", "top 10")',
        ),
      ambiguities: z
        .array(z.string())
        .optional()
        .describe('Note any ambiguous parts you identified'),
    }),
    execute: async (
      { question, breakdown, entities, filters, aggregation, ambiguities },
      options,
    ): Promise<DecomposedQueryResult> => {
      const state = toState<Chat4State>(options);

      const decomposition: QuestionDecomposition = {
        originalQuestion: question,
        breakdown,
        entities,
        filters,
        aggregation,
        ambiguities,
      };

      // Format the decomposition for the SQL agent
      const decomposedPrompt = formatDecomposition(decomposition);

      try {
        // Try SQL generation with retry logic
        let lastError: string | undefined;

        for (let attempt = 0; attempt < RETRY_TEMPERATURES.length; attempt++) {
          const temperature = RETRY_TEMPERATURES[attempt];

          const agentInstance = decompositionSqlAgent.clone({
            model: wrapLanguageModel({
              model: decompositionSqlAgent.model,
              middleware: defaultSettingsMiddleware({
                settings: { temperature },
              }),
            }),
          });

          const prompt = lastError
            ? `${decomposedPrompt}\n\nPrevious attempt failed with: ${lastError}. Please fix the query.`
            : decomposedPrompt;

          const { experimental_output: output } = await generate(
            agentInstance,
            [user(prompt)],
            state,
          );

          if ('error' in output) {
            return {
              success: false,
              question,
              decomposition,
              error: output.error,
              attempts: attempt + 1,
            };
          }

          // Validate the SQL
          const validationError = await state.adapter.validate(output.sql);
          if (validationError) {
            lastError = validationError;
            continue;
          }

          // Execute the SQL
          const data = await state.adapter.execute(output.sql);

          return {
            success: true,
            question,
            decomposition,
            sql: output.sql,
            data,
            reasoning: output.reasoning,
            attempts: attempt + 1,
          };
        }

        // All retries exhausted
        return {
          success: false,
          question,
          decomposition,
          error: `Failed after ${RETRY_TEMPERATURES.length} attempts. Last error: ${lastError}`,
          attempts: RETRY_TEMPERATURES.length,
        };
      } catch (error) {
        return {
          success: false,
          question,
          decomposition,
          error:
            error instanceof Error ? error.message : 'Unknown error occurred',
        };
      }
    },
  }),

  execute_sql: tool({
    description: `Execute a SQL query directly. Use for follow-up queries or when you already have SQL.`,
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .refine(
          (sql) =>
            sql.trim().toUpperCase().startsWith('SELECT') ||
            sql.trim().toUpperCase().startsWith('WITH'),
          {
            message: 'Only read-only SELECT or WITH queries are allowed.',
          },
        )
        .describe('The SQL query to execute.'),
    }),
    execute: async ({ sql }, options) => {
      const state = toState<Chat4State>(options);

      try {
        const validationError = await state.adapter.validate(sql);
        if (validationError) {
          return {
            success: false,
            error: `Validation failed: ${validationError}`,
          };
        }

        const data = await state.adapter.execute(sql);
        return {
          success: true,
          data,
          rowCount: Array.isArray(data) ? data.length : undefined,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Execution failed',
        };
      }
    },
  }),

  scratchpad: scratchpad_tool,
};

/**
 * Format a question decomposition into a prompt for the SQL agent
 */
function formatDecomposition(decomposition: QuestionDecomposition): string {
  const parts: string[] = [
    `Original Question: ${decomposition.originalQuestion}`,
    '',
    'Question Breakdown:',
    ...decomposition.breakdown.map((part, i) => `  ${i + 1}. ${part}`),
  ];

  if (decomposition.entities?.length) {
    parts.push('', `Entities: ${decomposition.entities.join(', ')}`);
  }

  if (decomposition.filters?.length) {
    parts.push('', `Filters: ${decomposition.filters.join(', ')}`);
  }

  if (decomposition.aggregation) {
    parts.push('', `Aggregation: ${decomposition.aggregation}`);
  }

  if (decomposition.ambiguities?.length) {
    parts.push(
      '',
      'Potential Ambiguities:',
      ...decomposition.ambiguities.map((a) => `  - ${a}`),
    );
  }

  parts.push(
    '',
    'Generate SQL that addresses each component of the breakdown.',
  );

  return parts.join('\n');
}

/**
 * Chat4 Agent - Table Augmented Generation with question decomposition.
 *
 * This agent breaks down questions into semantic components before
 * generating SQL. This approach:
 * - Ensures all aspects of the question are addressed
 * - Makes the reasoning explicit
 * - Helps with complex multi-part questions
 */
export const chat4Agent = agent<never, Chat4State>({
  name: 'chat4-decomposition',
  model: groq('openai/gpt-oss-20b'),
  tools,
  prompt: (state) => {
    return `
${state?.teachings || ''}
${state?.introspection || ''}

When answering questions that require database queries, use the query_with_decomposition tool.

IMPORTANT: You must break down the question into semantic parts - describe WHAT is being asked, not HOW to implement it.

Good breakdown example for "Which customers bought the most expensive products last quarter?":
- "customers who made purchases" (entity relationship)
- "products they purchased" (what products)
- "expensive products - need definition" (filter criteria - note ambiguity)
- "last quarter" (time filter)
- "most - ranking by count or value?" (aggregation - note ambiguity)

Bad breakdown (too instructional):
- "JOIN customers with orders" (this is HOW, not WHAT)
- "Use ORDER BY and LIMIT" (this is implementation)

Break the question into its semantic aspects, and let the SQL specialist figure out the implementation.
`;
  },
});

export { tools as chat4Tools };
