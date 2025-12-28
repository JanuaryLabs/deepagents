import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { agent, generate, toState } from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import type { Adapter } from '../adapters/adapter.ts';
import type { Teachables } from '../teach/teachables.ts';
import { explainerAgent } from './explainer.agent.ts';
import { toSql } from './sql.agent.ts';

/**
 * State passed to the developer agent
 */
export type DeveloperAgentState = {
  /** Database adapter for validation */
  adapter: Adapter;
  /** Schema introspection XML */
  introspection: string;
  /** Combined teachings/instructions */
  teachings: string;
  /** Instructions for SQL generation */
  instructions: Teachables[];
};

const tools = {
  /**
   * Generate SQL from natural language question.
   * Uses the toSql function with retry logic and validation.
   */
  generate_sql: tool({
    description: dedent`
      Generate a validated SQL query from a natural language question.
      The query is automatically validated against the database schema.
      Use this when the user asks a question that requires data retrieval.

      Returns the SQL query along with generation metadata (attempts, any errors encountered).
    `,
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .describe('The natural language question to convert to SQL'),
    }),
    execute: async ({ question }, options) => {
      const state = toState<DeveloperAgentState>(options);
      try {
        const result = await toSql({
          input: question,
          adapter: state.adapter,
          introspection: state.introspection,
          instructions: state.instructions,
        });
        return {
          success: true,
          sql: result.sql,
          attempts: result.attempts,
          errors: result.errors,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
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

  /**
   * Show database schema introspection.
   */
  show_schema: tool({
    description: dedent`
      Display the database schema introspection.
      Use this when the user wants to see available tables, columns, or relationships.

      Optionally filter by table name to reduce output.
    `,
    inputSchema: z.object({
      table: z
        .string()
        .optional()
        .describe(
          'Optional: filter to show only a specific table. If omitted, shows full schema.',
        ),
    }),
    execute: async ({ table }, options) => {
      const state = toState<DeveloperAgentState>(options);

      if (!table) {
        return { schema: state.introspection };
      }

      // Filter introspection to show only the requested table
      // The introspection is XML, so we do a simple string search
      const lines = state.introspection.split('\n');
      const tableLines: string[] = [];
      let inTable = false;
      let depth = 0;

      for (const line of lines) {
        const lowerLine = line.toLowerCase();

        // Check if this line starts the target table
        if (
          lowerLine.includes(`name="${table.toLowerCase()}"`) ||
          lowerLine.includes(`table="${table.toLowerCase()}"`)
        ) {
          inTable = true;
          depth = 1;
          tableLines.push(line);
          continue;
        }

        if (inTable) {
          tableLines.push(line);

          // Track depth for nested tags
          if (line.includes('</')) {
            depth--;
          }
          if (
            line.includes('<') &&
            !line.includes('</') &&
            !line.includes('/>')
          ) {
            depth++;
          }

          // End when we close the table tag
          if (depth <= 0) {
            break;
          }
        }
      }

      if (tableLines.length === 0) {
        return {
          schema: `Table "${table}" not found in schema. Use show_schema without a table filter to see all available tables.`,
        };
      }

      return { schema: tableLines.join('\n') };
    },
  }),

  /**
   * Developer scratchpad for notes and reasoning.
   */
  scratchpad: scratchpad_tool,
};

/**
 * Developer Agent - Power-user conversational interface for SQL generation
 *
 * This agent provides tools for SQL generation, validation, and explanation
 * without execution. Designed for developers/DBAs who want full control
 * over query building and refinement.
 *
 * Tools:
 * - generate_sql: Convert natural language to validated SQL
 * - validate_sql: Check SQL syntax without execution
 * - explain_sql: Get plain-English explanation of SQL
 * - show_schema: Display schema introspection on demand
 * - scratchpad: Developer notes/reasoning
 */
export const developerAgent = agent<never, DeveloperAgentState>({
  model: groq('gpt-oss-20b'),
  tools,
  name: 'developer_agent',
  prompt: (state) => {
    return dedent`
      You are an expert SQL developer assistant helping power users build and refine queries.

      ## Your Capabilities

      You have access to the following tools:

      1. **generate_sql**: Convert natural language questions to validated SQL queries
         - Automatically validates against the database schema
         - Returns generation metadata (attempts, errors if any)

      2. **explain_sql**: Get a plain-English explanation of any SQL query
         - Helps users understand complex queries
         - Focuses on intent and logic, not syntax

      3. **show_schema**: Display database schema information
         - Can show full schema or filter by table name
         - Use to explore available tables and columns

      4. **scratchpad**: Record your reasoning and notes

      ## Guidelines

      - Be transparent: show the SQL you generate before explaining it
      - Be precise: provide exact column names and table references
      - Be helpful: suggest refinements and alternatives when appropriate
      - Support both natural language questions AND raw SQL input
      - When validating user SQL, explain any errors clearly
      - Use show_schema proactively when you need to verify table/column names

      ${state?.teachings || ''}
      ${state?.introspection || ''}
    `;
  },
});
