import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { agent } from '@deepagents/agent';

type SqlGeneratorState = {
  introspection: string;
  question: string;
};

type SqlGeneratorOutput = {
  sql: string;
};

/**
 * Agent that generates SQL queries from introspection and natural language questions.
 * Used for creating synthetic training data for text-to-SQL models.
 */
export const sqlGeneratorAgent = agent<SqlGeneratorOutput, SqlGeneratorState>({
  name: 'sql_generator',
  model: groq('openai/gpt-oss-20b'),
  handoffDescription:
    'Generates SQL queries given database introspection and a natural language question.',
  output: z.object({
    sql: z.string().describe('The SQL query that answers the question'),
  }),
  prompt: (state) => {
    return dedent`
      <identity>
        You are an expert SQL query generator. You translate natural language questions
        into precise, efficient SQL queries based on the provided database schema.
      </identity>

      ${state?.introspection || ''}

      <question>
        ${state?.question || ''}
      </question>

      <task>
        Generate a SQL query that accurately answers the given question using the provided schema.
      </task>

      <guidelines>
        - Use only tables and columns that exist in the schema
        - Use appropriate JOINs based on the relationships defined
        - Apply proper aggregations (COUNT, SUM, AVG, etc.) when needed
        - Use meaningful aliases for readability
        - Add ORDER BY and LIMIT where appropriate
        - Handle NULL values appropriately
        - Use window functions when the question requires ranking, running totals, or comparisons
      </guidelines>

      <guardrails>
        - Generate ONLY valid, executable SQL
        - Do not include any explanations or comments
        - Only generate SELECT statements (read-only queries)
        - Ensure the query is optimized for the schema
      </guardrails>
    `;
  },
});
