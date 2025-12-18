/**
 * Chat1 Agent - Combined Tool, No Peek
 *
 * This variant uses a single `query_database` tool that:
 * 1. Takes a natural language question
 * 2. Internally calls toSql() to generate validated SQL
 * 3. Executes the SQL
 * 4. Returns both the SQL and results
 *
 * The agent does NOT see the SQL before execution - it's generated and executed in one step.
 */
import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import z from 'zod';

import { agent, toState } from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import type { Adapter } from '../adapters/adapter.ts';
import type { TeachablesStore } from '../memory/store.ts';
import type { Teachables } from '../teach/teachables.ts';
import { type ToSqlOptions, toSql } from './sql.agent.ts';

export type Chat1State = {
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
 * Result returned by the query_database tool
 */
export interface QueryDatabaseResult {
  success: boolean;
  /** The generated SQL query */
  sql?: string;
  /** Query results as array of rows */
  data?: unknown[];
  /** Error message if generation or execution failed */
  error?: string;
  /** Number of attempts made during SQL generation */
  attempts?: number;
}

const tools = {
  query_database: tool({
    description: `Query the database to answer a question. Provide your question in natural language and this tool will:
1. Generate the appropriate SQL query
2. Validate the SQL syntax
3. Execute the query
4. Return the results

Use this tool when you need to retrieve data to answer the user's question.`,
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .describe(
          'The question to answer, expressed in natural language. Be specific about what data you need.',
        ),
      reasoning: z
        .string()
        .optional()
        .describe(
          'Your reasoning for why this query is needed to answer the user.',
        ),
    }),
    execute: async ({ question }, options): Promise<QueryDatabaseResult> => {
      const state = toState<Chat1State>(options);

      try {
        // Generate SQL using the dedicated toSql function with validation and retry
        const sqlResult = await toSql({
          input: question,
          adapter: state.adapter,
          introspection: state.introspection,
          instructions: state.instructions,
        });

        // If SQL generation failed after all retries
        if (!sqlResult.sql) {
          return {
            success: false,
            error: sqlResult.errors?.join('; ') || 'Failed to generate SQL',
            attempts: sqlResult.attempts,
          };
        }

        // Execute the validated SQL
        const data = await state.adapter.execute(sqlResult.sql);

        return {
          success: true,
          sql: sqlResult.sql,
          data,
          attempts: sqlResult.attempts,
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

  scratchpad: scratchpad_tool,
};

/**
 * Chat1 Agent - Table Augmented Generation with combined query tool.
 *
 * This agent receives user questions and uses the query_database tool
 * to fetch data. The SQL generation is delegated to the specialized
 * sqlQueryAgent via the toSql() function.
 */
export const chat1Agent = agent<never, Chat1State>({
  name: 'chat1-combined',
  model: groq('openai/gpt-oss-20b'),
  tools,
  prompt: (state) => {
    return `
${state?.teachings || ''}
${state?.introspection || ''}
`;
  },
});

export { tools as chat1Tools };
