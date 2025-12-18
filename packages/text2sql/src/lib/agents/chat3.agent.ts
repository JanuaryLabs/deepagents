/**
 * Chat3 Agent - Agent Conversation/Collaboration
 *
 * This variant enables richer interaction between the conversation agent
 * and the SQL generation agent. The SQL agent can:
 * 1. Surface its confidence level
 * 2. State assumptions it's making
 * 3. Request clarification when uncertain
 *
 * The conversation agent can then:
 * - Answer clarifications from its context
 * - Ask the user for clarification
 * - Accept or refine the SQL agent's approach
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

export type Chat3State = {
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
 * Output schema for the collaborative SQL agent
 */
const collaborativeSqlOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    sql: z.string().describe('The generated SQL query'),
    confidence: z
      .enum(['high', 'medium', 'low'])
      .describe('Confidence level in this SQL being correct'),
    assumptions: z
      .array(z.string())
      .optional()
      .describe('Assumptions made during SQL generation'),
    reasoning: z
      .string()
      .optional()
      .describe('Brief explanation of the query approach'),
  }),
  z.object({
    status: z.literal('clarification_needed'),
    question: z.string().describe('Question to clarify the request'),
    context: z.string().optional().describe('Why this clarification is needed'),
    options: z
      .array(z.string())
      .optional()
      .describe('Possible options if applicable'),
  }),
  z.object({
    status: z.literal('unanswerable'),
    reason: z.string().describe('Why this question cannot be answered'),
    suggestions: z
      .array(z.string())
      .optional()
      .describe('Alternative questions that could be answered'),
  }),
]);

type CollaborativeSqlOutput = z.infer<typeof collaborativeSqlOutputSchema>;

/**
 * Internal agent for collaborative SQL generation.
 * This agent can ask for clarification instead of guessing.
 */
const collaborativeSqlAgent = agent<CollaborativeSqlOutput, Chat3State>({
  name: 'collaborative-sql',
  model: groq('openai/gpt-oss-20b'),
  output: collaborativeSqlOutputSchema,
  prompt: (state) => {
    return `
${toInstructions(
  'instructions',
  persona({
    name: 'SQLCollab',
    role: 'You are an expert SQL query generator that collaborates with the user to ensure accuracy.',
  }),
  ...(state?.instructions || []),
)}
${state?.introspection || ''}

IMPORTANT: You have three response options:

1. SUCCESS - When you can confidently generate SQL:
   - Provide the SQL query
   - Rate your confidence (high/medium/low)
   - List any assumptions you made

2. CLARIFICATION_NEEDED - When the question is ambiguous:
   - Ask a specific clarifying question
   - Explain why clarification is needed
   - Provide options if applicable

3. UNANSWERABLE - When the question cannot be answered with available data:
   - Explain why
   - Suggest alternative questions that could be answered

Prefer asking for clarification over making low-confidence guesses.
`;
  },
});

/**
 * Result from the collaborative query tool
 */
export interface CollaborativeQueryResult {
  /** Whether a final SQL was produced */
  success: boolean;
  /** The generated SQL (if success) */
  sql?: string;
  /** Query results (if executed) */
  data?: unknown[];
  /** Confidence level of the SQL */
  confidence?: 'high' | 'medium' | 'low';
  /** Assumptions made during generation */
  assumptions?: string[];
  /** Clarification question (if needed) */
  clarificationNeeded?: string;
  /** Context for clarification */
  clarificationContext?: string;
  /** Options for clarification */
  clarificationOptions?: string[];
  /** Reason if unanswerable */
  unanswerableReason?: string;
  /** Suggested alternatives if unanswerable */
  suggestions?: string[];
  /** Error message if something failed */
  error?: string;
}

const tools = {
  consult_sql_agent: tool({
    description: `Consult the SQL specialist agent to generate a query. The SQL agent may:
- Return a SQL query with confidence level and assumptions
- Ask for clarification if the question is ambiguous
- Indicate if the question cannot be answered with available data

Based on the response:
- If clarification is needed, you can provide context or ask the user
- If assumptions were made, verify them with the user for important queries
- If unanswerable, relay the suggestions to the user`,
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .describe('The question to translate into SQL.'),
      context: z
        .string()
        .optional()
        .describe('Additional context from the conversation that might help.'),
      previousClarification: z
        .string()
        .optional()
        .describe(
          'Answer to a previous clarification question from the SQL agent.',
        ),
    }),
    execute: async (
      { question, context, previousClarification },
      options,
    ): Promise<CollaborativeQueryResult> => {
      const state = toState<Chat3State>(options);

      try {
        // Build the message for the SQL agent
        let fullQuestion = question;
        if (context) {
          fullQuestion = `${question}\n\nAdditional context: ${context}`;
        }
        if (previousClarification) {
          fullQuestion = `${fullQuestion}\n\nClarification provided: ${previousClarification}`;
        }

        const agentInstance = collaborativeSqlAgent.clone({
          model: wrapLanguageModel({
            model: collaborativeSqlAgent.model,
            middleware: defaultSettingsMiddleware({
              settings: { temperature: 0.1 },
            }),
          }),
        });

        const { experimental_output: output } = await generate(
          agentInstance,
          [user(fullQuestion)],
          state,
        );

        // Handle the three response types
        if (output.status === 'success') {
          // Validate the SQL
          const validationError = await state.adapter.validate(output.sql);
          if (validationError) {
            return {
              success: false,
              error: `SQL validation failed: ${validationError}`,
            };
          }

          // Execute the SQL
          const data = await state.adapter.execute(output.sql);

          return {
            success: true,
            sql: output.sql,
            data,
            confidence: output.confidence,
            assumptions: output.assumptions,
          };
        }

        if (output.status === 'clarification_needed') {
          return {
            success: false,
            clarificationNeeded: output.question,
            clarificationContext: output.context,
            clarificationOptions: output.options,
          };
        }

        if (output.status === 'unanswerable') {
          return {
            success: false,
            unanswerableReason: output.reason,
            suggestions: output.suggestions,
          };
        }

        return {
          success: false,
          error: 'Unexpected response from SQL agent',
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
    description: `Execute a SQL query directly. Use this when you have SQL that you want to run
(e.g., after receiving SQL from consult_sql_agent or for follow-up queries).`,
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
      const state = toState<Chat3State>(options);

      try {
        // Validate first
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
 * Chat3 Agent - Table Augmented Generation with agent collaboration.
 *
 * This agent collaborates with a specialized SQL agent that can:
 * - Express confidence levels
 * - Surface assumptions
 * - Request clarification
 *
 * This enables higher quality SQL generation through dialogue.
 */
export const chat3Agent = agent<never, Chat3State>({
  name: 'chat3-collaborative',
  model: groq('openai/gpt-oss-20b'),
  tools,
  prompt: (state) => {
    return `
${state?.teachings || ''}
${state?.introspection || ''}

When answering questions that require database queries, use the consult_sql_agent tool.

The SQL agent may respond in three ways:
1. SUCCESS with SQL, confidence, and assumptions - review the confidence and assumptions
2. CLARIFICATION_NEEDED with a question - either answer from context or ask the user
3. UNANSWERABLE with reason and suggestions - relay this to the user helpfully

For medium/low confidence results, consider mentioning the assumptions to the user.
For clarification requests, try to answer from conversation context first before asking the user.
`;
  },
});

export { tools as chat3Tools };
