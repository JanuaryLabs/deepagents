---
title: 'Building a Text2SQL Agent'
description: 'On build agents generating SQL queries from natural language prompts.'
featured: 0
publishedAt: '2025-11-11T00:00:00.00Z'
---

An LLM is great at generating text based on patterns it has seen during training. This makes it a powerful tool for generating SQL queries from natural language prompts.

A simple agent that can do this would need to understand the database schema to generate accurate queries, the user input and good prompt engineering to guide the model towards generating valid SQL.

```ts
import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import z from 'zod';

import { agent } from '@deepagents/agent';

export const text2sqlAgent = agent<{ sql: string }, { schema: Introspection }>({
  name: 'text2sql',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => `
      <objective>
        Generate an SQL query based on the user question and database schema.
      </objective>
      <schema>
        ${state.schema}
      </schema>
  `,
  output: z.object({
    sql: z
      .string()
      .describe('The SQL query generated to answer the user question.'),
  }),
});

const { sql } = toOutput(
  await generate(
    text2sqlAgent,
    [user('List all users who signed up in the last 30 days.')],
    { schema: await introspect('postgres://user:pass@host:5432/db') },
  ),
);

console.log(`Generated SQL: ${sql}`);
```

### Context Engineering

I've been experimenting with different ways to provide enough proper context to the agent to generate not just valid SQL query but also sufficient for the user question/prompt.

**Database Schema Awareness**

The very first thing I thought of is to make the agent aware of the database schema. This is crucial because without knowing the tables, columns, and relationships, the agent would be shooting in the dark. but awarness wasn't enough. the agent also needed to understand this schema in a way that it can use it effectively.

**Schema Understanding**

The understanding part here means is to create a natural language description of the schema which led to create the "breif" agent.

Given the database schema and a tool to execute a database query, the "breif" agent would output a natural language description of the data in question similar to how a human would describe it.

Up until now the agent had two pieces of context:

1. Database schema.
2. Natural language description of the schema.

The agent was able to generate better SQL queries with this context but it was still negligent and carless when it comes to generate optimised queries.

To address this, I augmented the database schema to have not only the structure but also an idea about the data it contains. For instance, instead of just having a table named `users` with columns `id`, `name`, `email`, `status` and `created_at`, the schema would also include information like "the `users` table contains 10,000 records" and "the `status` column has the following values 'active', 'inactive', 'pending'". (low cardinality)

Right after this the agent started to generate much more accurate and optimised SQL queries.

**Database Views**

I was lucky enough to work with a database that had a lot of views created on top of the base tables. These views were designed to answer common questions and use cases. I thought this views are great addition as few shot examples to guide the agent on how to generate SQL queries.

I took a few of these views and added them to the context as few shot examples. This helped the agent to understand the patterns and structures of SQL queries that are relevant to the specific database.
