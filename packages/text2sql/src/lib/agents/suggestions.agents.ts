import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { agent, thirdPersonPrompt } from '@deepagents/agent';

import type { Introspection } from '../adapters/adapter.ts';
import { databaseSchemaPrompt } from '../prompt.ts';

type SuggestionsAgentContext = {
  context?: string;
  adapterInfo?: string;
};
type SuggestionsAgentOutput = {
  suggestions: {
    question: string;
    sql: string;
    businessValue: string;
  }[];
};

export const suggestionsAgent = agent<
  SuggestionsAgentOutput,
  SuggestionsAgentContext
>({
  name: 'text2sql-suggestions',
  model: groq('openai/gpt-oss-20b'),
  output: z.object({
    suggestions: z
      .array(
        z.object({
          question: z
            .string()
            .describe('A complex, high-impact business question.'),
          sql: z
            .string()
            .describe('The SQL statement needed to answer the question.'),
          businessValue: z
            .string()
            .describe('Why the question matters to stakeholders.'),
        }),
      )
      .min(1)
      .max(5)
      .describe('A set of up to two advanced question + SQL pairs.'),
  }),
  prompt: (state) => {
    return dedent`
      ${thirdPersonPrompt()}

      <identity>
        You are a senior analytics strategist who proposes ambitious business questions
        and drafts the SQL needed to answer them. You specialize in identifying ideas
        that combine multiple tables, apply segmentation or time analysis, and surface
        metrics that drive executive decisions.
      </identity>


      <instructions>
        - Recommend one or two UNIQUE questions that go beyond simple counts or listings.
        - Favor questions that require joins, aggregates, time comparisons, cohort analysis,
          or window functions.
        - For each question, explain the business reason stakeholders care about it.
        - Provide the complete SQL query that could answer the question in the given schema.
        - Keep result sets scoped with LIMIT clauses (max 50 rows) when returning raw rows.
        - Ensure table/column names match the provided schema exactly.
        - Use columns marked [LowCardinality: ...] to identify meaningful categorical filters or segmentations.
        - Leverage table [rows / size] hints to determine whether to aggregate (large tables) or inspect detailed data (tiny tables).
        - Reference PK/Indexed annotations and the Indexes list to recommend queries that use efficient join/filter paths.
        - Column annotations may expose ranges/null percentages—use them to suggest realistic thresholds or quality checks.
        - Consult <relationship_examples> to anchor your recommendations in the actual join paths between tables.
        - Output only information grounded in the schema/context provided.
      </instructions>

      <response-format>
        Return valid JSON that satisfies the defined output schema.
      </response-format>
    `;
  },
});
