import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  InMemoryContextStore,
  fragment,
  guardrail,
  persona,
  structuredOutput,
  user,
} from '@deepagents/context';

export type QuestionComplexity =
  | 'simple'
  | 'moderate'
  | 'complex'
  | 'high complex';

const complexityInstructions: Record<QuestionComplexity, string> = {
  simple: dedent`
    Generate simple questions that require:
    - Basic SELECT with single table
    - Simple WHERE clauses with one condition
    - COUNT(*) or basic aggregations
    - No joins required
    Examples: "How many customers do we have?", "List all products", "What is the total revenue?"
  `,
  moderate: dedent`
    Generate moderate questions that require:
    - JOINs between 2-3 tables
    - Multiple WHERE conditions (AND/OR)
    - GROUP BY with HAVING clauses
    - ORDER BY with LIMIT
    - Basic subqueries
    Examples: "What are the top 5 customers by total orders?", "Which products have never been ordered?"
  `,
  complex: dedent`
    Generate complex questions that require:
    - Multiple JOINs (3+ tables)
    - Nested subqueries or CTEs
    - Complex aggregations with multiple GROUP BY columns
    - CASE expressions
    - Date/time calculations
    Examples: "What is the month-over-month growth rate?", "Which customers have increased spending compared to last year?"
  `,
  'high complex': dedent`
    Generate highly complex questions that require advanced SQL features:
    - Window functions (ROW_NUMBER, RANK, DENSE_RANK)
    - LAG, LEAD for comparisons
    - Running totals (SUM OVER)
    - Moving averages
    - PARTITION BY clauses
    - Complex CTEs with multiple levels
    Examples: "What is the running total of sales per month?", "Rank customers by their purchase frequency within each region"
  `,
};

const outputSchema = z.object({
  questions: z
    .array(z.string().describe('A natural language question about the data'))
    .min(1)
    .describe('List of natural language questions a user might ask'),
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

  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: `question-gen-${crypto.randomUUID()}`,
    userId: 'system',
  });

  context.set(
    persona({
      name: 'question_generator',
      role: 'You are a synthetic data generator specializing in creating realistic natural language questions that users might ask about a database.',
      objective:
        'Generate diverse, realistic natural language questions that match the specified complexity level',
    }),
    fragment('database_schema', introspection || ''),
    fragment(
      'complexity',
      { level: complexity },
      complexityInstructions[complexity],
    ),
    fragment(
      'task',
      dedent`
        Generate exactly ${count} natural language questions at the "${complexity}" complexity level.
        The questions should:
        1. Match the complexity requirements above
        2. Use natural business language, not technical SQL terms
        3. Be realistic questions a non-technical user would actually ask
        4. Cover different tables and relationships when possible
      `,
    ),
    guardrail({
      rule: 'Questions MUST ONLY reference tables and columns that exist in the schema above',
    }),
    guardrail({
      rule: 'Before generating each question, verify that ALL entities (tables, columns, relationships) you reference are explicitly listed in the schema',
    }),
    guardrail({
      rule: 'DO NOT invent or assume tables/columns that are not explicitly shown in the schema',
    }),
    guardrail({
      rule: 'Use natural language without SQL keywords like SELECT, WHERE, etc.',
    }),
    guardrail({
      rule: 'All questions must match the specified complexity level',
    }),
    user(
      prompt ??
        `Generate ${count} questions at ${complexity} complexity given db schema.`,
    ),
  );

  const questionOutput = structuredOutput({
    model: model ?? groq('openai/gpt-oss-20b'),
    context,
    schema: outputSchema,
  });

  return questionOutput.generate();
}
