import { tool } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { generate, toState } from '@deepagents/agent';
import { type ContextFragment, hint, persona } from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';
import { explainerAgent } from './explainer.agent.ts';

/**
 * Context variables passed to the developer agent tools via stream().
 */
export type DeveloperContextVariables = {
  /** Database adapter for validation and execution */
  adapter: Adapter;
};

/**
 * Tools for the developer agent.
 * Following the text2sql.agent.ts pattern - LLM writes SQL directly.
 */
const tools = {
  /**
   * Validate SQL query syntax before execution.
   */
  validate_query: tool({
    description: `Validate SQL query syntax before execution. Use this to check if your SQL is valid before running db_query. This helps catch errors early and allows you to correct the query if needed.`,
    inputSchema: z.object({
      sql: z.string().describe('The SQL query to validate.'),
    }),
    execute: async ({ sql }, options) => {
      const state = toState<DeveloperContextVariables>(options);
      const result = await state.adapter.validate(sql);
      if (typeof result === 'string') {
        return `Validation Error: ${result}`;
      }
      return 'Query is valid.';
    },
  }),

  /**
   * Execute SQL query against the database.
   */
  db_query: tool({
    description: `Internal tool to fetch data from the store's database. Write a SQL query to retrieve the information needed to answer the user's question. The results will be returned as data that you can then present to the user in natural language.`,
    inputSchema: z.object({
      reasoning: z
        .string()
        .describe(
          'Your reasoning for why this SQL query is relevant to the user request.',
        ),
      sql: z
        .string()
        .min(1, { message: 'SQL query cannot be empty.' })
        .refine(
          (sql) =>
            sql.trim().toUpperCase().startsWith('SELECT') ||
            sql.trim().toUpperCase().startsWith('WITH'),
          {
            message: 'Only read-only SELECT or WITH queries are allowed.',
          },
        )
        .describe('The SQL query to execute against the database.'),
    }),
    execute: ({ sql }, options) => {
      const state = toState<DeveloperContextVariables>(options);
      return state.adapter.execute(sql);
    },
  }),

  /**
   * Get plain-English explanation of a SQL query.
   */
  explain_sql: tool({
    description: dedent`
      Get a plain-English explanation of a SQL query.
      Use this to help the user understand what a query does.

      The explanation focuses on intent and logic, not syntax.
    `,
    inputSchema: z.object({
      sql: z.string().min(1).describe('The SQL query to explain'),
    }),
    execute: async ({ sql }) => {
      const { experimental_output } = await generate(explainerAgent, [], {
        sql,
      });
      return { explanation: experimental_output.explanation };
    },
  }),
};

/**
 * Context fragments defining the developer agent's persona and behavior.
 */
const fragments: ContextFragment[] = [
  persona({
    name: 'developer_assistant',
    role: 'You are an expert SQL developer assistant helping power users build and refine queries.',
  }),
  hint('Be transparent: show the SQL you generate before explaining it'),
  hint('Be precise: provide exact column names and table references'),
  hint('Suggest refinements and alternatives when appropriate'),
  hint('Support both natural language questions AND raw SQL input'),
  hint('When validating user SQL, explain any errors clearly'),
];

/**
 * Developer agent exports - tools and context fragments.
 * The agent is constructed dynamically in sql.ts developer() method.
 */
export default { tools, fragments };
