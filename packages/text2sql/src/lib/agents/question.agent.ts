import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { type AgentModel, agent, generate, user } from '@deepagents/agent';

export type QuestionComplexity = 'low' | 'medium' | 'hard' | 'window';

type QuestionGeneratorState = {
  introspection: string;
  complexity: QuestionComplexity;
  count: number;
};

type QuestionGeneratorOutput = {
  questions: string[];
};

const complexityInstructions: Record<QuestionComplexity, string> = {
  low: dedent`
    Generate simple questions that require:
    - Basic SELECT with single table
    - Simple WHERE clauses with one condition
    - COUNT(*) or basic aggregations
    - No joins required
    Examples: "How many customers do we have?", "List all products", "What is the total revenue?"
  `,
  medium: dedent`
    Generate moderate questions that require:
    - JOINs between 2-3 tables
    - Multiple WHERE conditions (AND/OR)
    - GROUP BY with HAVING clauses
    - ORDER BY with LIMIT
    - Basic subqueries
    Examples: "What are the top 5 customers by total orders?", "Which products have never been ordered?"
  `,
  hard: dedent`
    Generate complex questions that require:
    - Multiple JOINs (3+ tables)
    - Nested subqueries or CTEs
    - Complex aggregations with multiple GROUP BY columns
    - CASE expressions
    - Date/time calculations
    Examples: "What is the month-over-month growth rate?", "Which customers have increased spending compared to last year?"
  `,
  window: dedent`
    Generate advanced questions that require window functions:
    - ROW_NUMBER, RANK, DENSE_RANK
    - LAG, LEAD for comparisons
    - Running totals (SUM OVER)
    - Moving averages
    - PARTITION BY clauses
    Examples: "What is the running total of sales per month?", "Rank customers by their purchase frequency within each region"
  `,
};

/**
 * Agent that generates natural language questions from database introspection.
 * Used for creating synthetic training data for text-to-SQL models.
 */
const questionGeneratorAgent = agent<
  QuestionGeneratorOutput,
  QuestionGeneratorState
>({
  name: 'question_generator',
  model: wrapLanguageModel({
    model: groq('openai/gpt-oss-20b'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.8, topP: 0.95 },
    }),
  }),
  handoffDescription:
    'Generates natural language questions that users might ask about the database schema.',
  output: z.object({
    questions: z
      .array(z.string().describe('A natural language question about the data'))
      .min(1)
      .describe('List of natural language questions a user might ask'),
  }),
  prompt: (state) => {
    const count = state?.count;
    const complexity = state?.complexity ?? 'medium';

    return dedent`
      <identity>
        You are a synthetic data generator specializing in creating realistic natural language questions
        that users might ask about a database. You understand database schemas and can generate diverse,
        practical questions that would require SQL queries to answer.
      </identity>

      ${state?.introspection || ''}

      <complexity level="${complexity}">
        ${complexityInstructions[complexity]}
      </complexity>

      <task>
        Generate exactly ${count} natural language questions at the "${complexity}" complexity level.
        The questions should:
        1. Match the complexity requirements above
        2. Use natural business language, not technical SQL terms
        3. Be realistic questions a non-technical user would actually ask
        4. Cover different tables and relationships when possible
      </task>

      <guardrails>
        - Questions MUST ONLY reference tables and columns that exist in the schema above
        - Before generating each question, verify that ALL entities (tables, columns, relationships) you reference are explicitly listed in the schema
        - DO NOT invent or assume tables/columns that aren't explicitly shown in the schema
        - Use natural language without SQL keywords like SELECT, WHERE, etc.
        - All questions must match the specified complexity level
      </guardrails>
    `;
  },
});

export interface GenerateQuestionsParams {
  /** Database schema introspection */
  introspection: string;
  /** Complexity level for generated questions */
  complexity: QuestionComplexity;
  /** Number of questions to generate */
  count: number;
  /** Optional prompt to prepend (e.g., persona context) */
  prompt?: string;
  /** Optional model override */
  model?: AgentModel;
}

export interface GenerateQuestionsResult {
  questions: string[];
}

/**
 * Generate natural language questions from database schema.
 * Used for creating synthetic training data for text-to-SQL models.
 */
export async function generateQuestions(
  params: GenerateQuestionsParams,
): Promise<GenerateQuestionsResult> {
  const { introspection, complexity, count, prompt, model } = params;

  const agentInstance = model
    ? questionGeneratorAgent.clone({ model })
    : questionGeneratorAgent;

  const userPrompt =
    prompt ?? `Generate ${count} questions at ${complexity} complexity given db schema.`;

  const { experimental_output } = await generate(agentInstance, [user(userPrompt)], {
    introspection,
    complexity,
    count,
  });

  return { questions: experimental_output.questions };
}
