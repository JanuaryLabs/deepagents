import { groq } from '@ai-sdk/groq';
import { type Tool, tool } from 'ai';
import z from 'zod';

import { agent, toState } from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import type { Adapter } from '../adapters/adapter.ts';
import memoryPrompt from '../memory/memory.prompt.ts';
import type { TeachablesStore } from '../memory/store.ts';
import type { GeneratedTeachable } from '../teach/teachables.ts';

export type RenderingTools = Record<string, Tool<unknown, never>>;

const tools = {
  validate_query: tool({
    description: `Validate SQL query syntax before execution. Use this to check if your SQL is valid before running db_query. This helps catch errors early and allows you to correct the query if needed.`,
    inputSchema: z.object({
      sql: z.string().describe('The SQL query to validate.'),
    }),
    execute: async ({ sql }, options) => {
      const state = toState<{ adapter: Adapter }>(options);
      const result = await state.adapter.validate(sql);
      if (typeof result === 'string') {
        return `Validation Error: ${result}`;
      }
      return 'Query is valid.';
    },
  }),
  get_sample_rows: tool({
    description: `Sample rows from a table to understand data formatting, codes, and value patterns. Use BEFORE writing queries when:
- Column types in schema don't reveal format (e.g., "status" could be 'active'/'inactive' or 1/0)
- Date/time formats are unclear (ISO, Unix timestamp, locale-specific)
- You need to understand lookup table codes or enum values
- Column names are ambiguous (e.g., "type", "category", "code")`,
    inputSchema: z.object({
      tableName: z.string().describe('The name of the table to sample.'),
      columns: z
        .array(z.string())
        .optional()
        .describe(
          'Specific columns to sample. If omitted, samples all columns.',
        ),
      limit: z
        .number()
        .min(1)
        .max(10)
        .default(3)
        .optional()
        .describe('Number of rows to sample (1-10, default 3).'),
    }),
    execute: ({ tableName, columns, limit = 3 }, options) => {
      const safeLimit = Math.min(Math.max(1, limit), 10);
      const state = toState<{ adapter: Adapter }>(options);
      const sql = state.adapter.buildSampleRowsQuery(
        tableName,
        columns,
        safeLimit,
      );
      return state.adapter.execute(sql);
    },
  }),
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
      const state = toState<{ adapter: Adapter }>(options);
      return state.adapter.execute(sql);
    },
  }),
  scratchpad: scratchpad_tool,
};

const userMemoryTypes = [
  'identity',
  'alias',
  'preference',
  'context',
  'correction',
] as const;

const userMemorySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('identity'),
    description: z.string().describe("The user's identity: role or/and name"),
  }),
  z.object({
    type: z.literal('alias'),
    term: z.string().describe('The term the user uses'),
    meaning: z.string().describe('What the user means by this term'),
  }),
  z.object({
    type: z.literal('preference'),
    aspect: z
      .string()
      .describe('What aspect of output this preference applies to'),
    value: z.string().describe("The user's preference"),
  }),
  z.object({
    type: z.literal('context'),
    description: z.string().describe('What the user is currently working on'),
  }),
  z.object({
    type: z.literal('correction'),
    subject: z.string().describe('What was misunderstood'),
    clarification: z.string().describe('The correct understanding'),
  }),
]);

export const memoryTools = {
  remember_memory: tool({
    description:
      'Store something about the user for future conversations. Use silently when user shares facts, preferences, vocabulary, corrections, or context.',
    inputSchema: z.object({ memory: userMemorySchema }),
    execute: async ({ memory }, options) => {
      const state = toState<{ memory: TeachablesStore; userId: string }>(
        options,
      );
      await state.memory.remember(state.userId, memory as GeneratedTeachable);
      return 'Remembered.';
    },
  }),
  forget_memory: tool({
    description:
      'Forget a specific memory. Use when user asks to remove something.',
    inputSchema: z.object({
      id: z.string().describe('The ID of the teachable to forget'),
    }),
    execute: async ({ id }, options) => {
      const state = toState<{ memory: TeachablesStore }>(options);
      await state.memory.forget(id);
      return 'Forgotten.';
    },
  }),
  recall_memory: tool({
    description:
      'List stored memories for the current user. Use when user asks what you remember about them or wants to see their stored preferences.',
    inputSchema: z.object({
      type: z
        .enum(userMemoryTypes)
        .optional()
        .catch(undefined)
        .describe('Optional: filter by memory type'),
    }),
    execute: async ({ type }, options) => {
      const state = toState<{ memory: TeachablesStore; userId: string }>(
        options,
      );
      const memories = await state.memory.recall(state.userId, type);
      if (memories.length === 0) {
        return type ? `No ${type} memories stored.` : 'No memories stored.';
      }
      return memories.map((m) => ({
        id: m.id,
        type: m.type,
        data: m.data,
        createdAt: m.createdAt,
      }));
    },
  }),
  update_memory: tool({
    description:
      'Update an existing memory. Use when user wants to modify something you previously stored.',
    inputSchema: z.object({
      memory: userMemorySchema,
      id: z.string().describe('The ID of the memory to update'),
    }),
    execute: async ({ id, memory }, options) => {
      const state = toState<{ memory: TeachablesStore }>(options);
      await state.memory.update(id, memory as GeneratedTeachable);
      return 'Updated.';
    },
  }),
};

/**
 * Chain of Thought prompt for text-to-SQL.
 *
 * Research-backed approach:
 * - Keep reasoning concise to avoid error propagation (EMNLP 2023)
 * - Focus on schema linking and database operations (Struct-SQL 2025)
 * - Use intermediate representations for complex queries
 *
 * @see https://arxiv.org/abs/2305.14215
 * @see https://arxiv.org/html/2512.17053
 */
const chainOfThoughtPrompt = `
## Query Reasoning Process

Let's think step by step before writing SQL:

1. **Schema Link**: Which tables and columns are relevant? Verify they exist in the schema.
2. **Join Path**: If multiple tables, what relationships connect them?
3. **Filters**: What WHERE conditions are needed?
4. **Aggregation**: Is COUNT, SUM, AVG, GROUP BY, or HAVING required?
5. **Output**: What columns to SELECT and any ORDER BY or LIMIT?
6. **Verify**: Do all referenced tables and columns exist in the schema above?

For simple queries, steps 2-4 may not apply—skip them.

For complex queries requiring multiple data points, decompose into sub-questions:
- Break the question into simpler parts (Q1, Q2, ...)
- Determine if each part needs a subquery or CTE
- Combine the parts into the final query

Keep reasoning brief. Verbose explanations cause errors.
`;

/**
 * Few-shot examples demonstrating the CoT reasoning process.
 * Uses abstract placeholders (table_a, column_x) for maximum generalization.
 */
const fewShotExamples = `
## Examples

### Example 1: Simple Filter
Question: "How many records in table_a have column_x equal to 'value'?"
Reasoning:
- Schema Link: table_a, column_x
- Filters: column_x = 'value'
- Aggregation: COUNT(*)
SQL: SELECT COUNT(*) FROM table_a WHERE column_x = 'value'

### Example 2: JOIN Query
Question: "Show column_y from table_b for each record in table_a where column_x is 'value'"
Reasoning:
- Schema Link: table_a (column_x, id), table_b (column_y, fk_a)
- Join Path: table_a.id → table_b.fk_a
- Filters: column_x = 'value'
- Output: column_y from table_b
SQL: SELECT b.column_y FROM table_a a JOIN table_b b ON b.fk_a = a.id WHERE a.column_x = 'value'

### Example 3: Aggregation with GROUP BY
Question: "What is the total of column_y grouped by column_x?"
Reasoning:
- Schema Link: table_a (column_x, column_y)
- Aggregation: SUM(column_y), GROUP BY column_x
- Output: column_x, sum
SQL: SELECT column_x, SUM(column_y) as total FROM table_a GROUP BY column_x

### Example 4: Complex Aggregation
Question: "Which values of column_x have more than 10 records, sorted by count descending?"
Reasoning:
- Schema Link: table_a (column_x)
- Aggregation: COUNT(*), GROUP BY column_x, HAVING > 10
- Output: column_x, count, ORDER BY count DESC
SQL: SELECT column_x, COUNT(*) as cnt FROM table_a GROUP BY column_x HAVING COUNT(*) > 10 ORDER BY cnt DESC

### Example 5: Subquery (Decomposition)
Question: "Show records from table_a where column_y is above average"
Reasoning:
- Decompose:
  - Q1: What is the average of column_y?
  - Q2: Which records have column_y above that value?
- Schema Link: table_a (column_y)
- Filters: column_y > (result of Q1)
- Output: all columns from matching records
- Verify: table_a and column_y exist ✓
SQL: SELECT * FROM table_a WHERE column_y > (SELECT AVG(column_y) FROM table_a)

### Example 6: Complex Multi-Join (Decomposition)
Question: "Find the top 3 categories by total sales amount for orders placed last month"
Reasoning:
- Decompose:
  - Q1: Which orders were placed last month?
  - Q2: What is the total sales per category for those orders?
  - Q3: Which 3 categories have the highest totals?
- Schema Link: orders (order_date, id), order_items (order_id, amount, product_id), products (id, category_id), categories (id, name)
- Join Path: orders → order_items → products → categories
- Filters: order_date within last month
- Aggregation: SUM(amount), GROUP BY category
- Output: category name, total, ORDER BY total DESC, LIMIT 3
- Verify: all tables and columns exist ✓
SQL: SELECT c.name, SUM(oi.amount) as total FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id JOIN categories c ON c.id = p.category_id WHERE o.order_date >= DATE('now', '-1 month') GROUP BY c.id, c.name ORDER BY total DESC LIMIT 3
`;

/**
 * An agent that does Table Augmented Generation for Text-to-SQL tasks.
 */
export const t_a_g = agent<
  { sql: string },
  {
    // FIXME: this should not be here after creating the context package
    introspection: string;
    teachings: string;
    memory?: TeachablesStore;
    userId?: string;
  }
>({
  model: groq('openai/gpt-oss-20b'),
  tools,
  name: 'text2sql',
  prompt: (state) => {
    const hasMemory = !!state?.memory;

    return `
    ${state?.teachings || ''}
    ${state?.introspection || ''}

    ${chainOfThoughtPrompt}

    ${fewShotExamples}

    ${hasMemory ? memoryPrompt : ''}
  `;
  },
});
