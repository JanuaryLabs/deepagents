import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { agent } from '@deepagents/agent';

export const explainerAgent = agent<{ explanation: string }, { sql: string }>({
  name: 'explainer',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => dedent`
    You are an expert SQL tutor.
    Explain the following SQL query in plain English to a non-technical user.
    Focus on the intent and logic, not the syntax.

    <sql>
    ${state?.sql}
    </sql>
  `,
  output: z.object({
    explanation: z.string().describe('The explanation of the SQL query.'),
  }),
});
