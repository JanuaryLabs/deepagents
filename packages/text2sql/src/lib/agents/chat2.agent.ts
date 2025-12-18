/**
 * Chat2 Agent - Separate Generate + Execute Tools (With Peek)
 *
 * This variant uses two separate tools:
 * 1. `generate_sql` - Takes a question, returns validated SQL (agent can inspect it)
 * 2. `execute_sql` - Takes SQL, executes it, returns results
 *
 * The agent sees the SQL before execution and can:
 * - Review the generated SQL
 * - Explain the approach to the user
 * - Decide to refine the question and regenerate
 * - Choose not to execute if something looks wrong
 */
import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import z from 'zod';

import { agent, toState } from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import type { Adapter } from '../adapters/adapter.ts';
import type { TeachablesStore } from '../memory/store.ts';
import type { Teachables } from '../teach/teachables.ts';
import { toSql } from './sql.agent.ts';

export type Chat2State = {
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
 * Result returned by the generate_sql tool
 */
export interface GenerateSqlToolResult {
  success: boolean;
  /** The generated and validated SQL query */
  sql?: string;
  /** Error message if generation failed */
  error?: string;
  /** Number of attempts made during SQL generation */
  attempts?: number;
  /** Validation errors encountered during generation */
  validationErrors?: string[];
}

/**
 * Result returned by the execute_sql tool
 */
export interface ExecuteSqlToolResult {
  success: boolean;
  /** Query results as array of rows */
  data?: unknown[];
  /** Error message if execution failed */
  error?: string;
  /** Row count of results */
  rowCount?: number;
}

const tools = {
  generate_sql: tool({
    description: `Generate a SQL query from a natural language question. This tool will:
1. Translate your question into SQL
2. Validate the SQL syntax
3. Retry with corrections if validation fails
4. Return the validated SQL for your review

Use this BEFORE execute_sql to see what query will be run. You can then:
- Explain the approach to the user
- Decide if the SQL looks correct
- Refine your question and regenerate if needed`,
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .describe(
          'The question to translate into SQL. Be specific about what data you need.',
        ),
      reasoning: z
        .string()
        .optional()
        .describe('Your reasoning for why this data is needed.'),
    }),
    execute: async ({ question }, options): Promise<GenerateSqlToolResult> => {
      const state = toState<Chat2State>(options);

      try {
        const sqlResult = await toSql({
          input: question,
          adapter: state.adapter,
          introspection: state.introspection,
          instructions: state.instructions,
        });

        if (!sqlResult.sql) {
          return {
            success: false,
            error: sqlResult.errors?.join('; ') || 'Failed to generate SQL',
            attempts: sqlResult.attempts,
            validationErrors: sqlResult.errors,
          };
        }

        return {
          success: true,
          sql: sqlResult.sql,
          attempts: sqlResult.attempts,
          validationErrors: sqlResult.errors,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : 'Unknown error occurred',
        };
      }
    },
  }),

  execute_sql: tool({
    description: `Execute a SQL query and return the results. Use this AFTER generate_sql to run the query.

Only SELECT and WITH (CTE) queries are allowed - no data modification.`,
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
        .describe('The SQL query to execute (must be SELECT or WITH).'),
      reasoning: z
        .string()
        .optional()
        .describe('Brief explanation of what this query retrieves.'),
    }),
    execute: async ({ sql }, options): Promise<ExecuteSqlToolResult> => {
      const state = toState<Chat2State>(options);

      try {
        const data = await state.adapter.execute(sql);

        return {
          success: true,
          data,
          rowCount: Array.isArray(data) ? data.length : undefined,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : 'Query execution failed',
        };
      }
    },
  }),

  scratchpad: scratchpad_tool,
};

/**
 * Chat2 Agent - Table Augmented Generation with peek support.
 *
 * This agent uses separate generate_sql and execute_sql tools,
 * allowing it to review the SQL before execution. This enables:
 * - Transparency: Agent knows what SQL will be run
 * - Control: Agent can refine before executing
 * - Explanation: Agent can describe its approach to the user
 */
export const chat2Agent = agent<never, Chat2State>({
  name: 'chat2-with-peek',
  model: groq('openai/gpt-oss-20b'),
  tools,
  prompt: (state) => {
    return `
${state?.teachings || ''}
${state?.introspection || ''}

When answering questions that require database queries:
1. First use generate_sql to create the SQL query
2. Review the generated SQL to ensure it matches the user's intent
3. Use execute_sql to run the query
4. Present the results to the user

If the generated SQL doesn't look right, you can refine your question and regenerate.
`;
  },
});

export { tools as chat2Tools };
