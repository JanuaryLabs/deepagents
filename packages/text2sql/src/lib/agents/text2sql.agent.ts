import { groq } from '@ai-sdk/groq';
import { type Tool, tool } from 'ai';
import z from 'zod';

import {
  type StepBackExample,
  agent,
  stepBackPrompt,
  toState,
} from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import type { Adapter, Introspection } from '../adapters/adapter.ts';
import memoryPrompt from '../memory/memory.prompt.ts';
import type { TeachablesStore } from '../memory/store.ts';
import { databaseSchemaPrompt } from '../prompt.ts';
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
    description: `Get a few sample rows from a table to understand data formatting and values. Use this when you are unsure about the content of a column (e.g. date formats, status codes, string variations).`,
    inputSchema: z.object({
      tableName: z.string().describe('The name of the table to sample.'),
    }),
    execute: ({ tableName }, options) => {
      tableName = tableName.replace(/[^a-zA-Z0-9_.]/g, '');
      const state = toState<{ adapter: Adapter }>(options);
      return state.adapter.execute(`SELECT * FROM ${tableName} LIMIT 3`);
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
  'role',
  'alias',
  'preference',
  'context',
  'correction',
] as const;

const userMemorySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('role'),
    description: z.string().describe("The user's role or identity"),
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

const getRenderingGuidance = (renderingTools?: RenderingTools) => {
  const renderingToolNames = Object.keys(renderingTools ?? {}).filter(
    (toolName) => toolName.startsWith('render_'),
  );

  if (!renderingToolNames.length) {
    return { constraint: undefined, section: '' };
  }

  return {
    constraint:
      '**Rendering**: Use a render_* visualization tool for trend/over time/monthly requests or explicit chart asks; otherwise provide the insight in text.',
    section: `
    <rendering_tools>
      Rendering tools available: ${renderingToolNames.join(', ')}.
      Use the matching render_* tool when the user requests a chart or mentions trends/over time/monthly performance. Prefer a line chart for those time-based requests. Always include a concise text insight alongside any visualization; if no suitable render_* tool fits, deliver the insight in text only.
    </rendering_tools>
    `,
  };
};

const SQL_STEP_BACK_EXAMPLES: StepBackExample[] = [
  {
    originalQuestion: 'Who are our top 5 customers by spending?',
    stepBackQuestion:
      'What are the SQL principles for ranking and aggregation queries?',
    stepBackAnswer:
      'Ranking queries require: 1) Aggregation functions (SUM, COUNT, AVG) grouped by the entity to rank, 2) JOINs to connect related data across tables (e.g., Customer to Invoice), 3) ORDER BY to sort by the aggregated metric, 4) LIMIT to restrict to top N results. For customer spending, join Customer and Invoice tables, sum invoice totals, group by customer identifier, order by total descending.',
    finalAnswer:
      'SELECT c.FirstName, c.LastName, SUM(i.Total) as total_spent FROM Customer c JOIN Invoice i ON c.CustomerId = i.CustomerId GROUP BY c.CustomerId ORDER BY total_spent DESC LIMIT 5',
  },
  {
    originalQuestion: 'Show me sales by month for 2013',
    stepBackQuestion:
      'What are the principles of time-based grouping and aggregation in SQL?',
    stepBackAnswer:
      'Time-based queries require: 1) Date extraction functions (e.g., DATE_TRUNC, strftime, YEAR/FORMAT) to bucket timestamps, 2) WHERE clauses to filter the date range, 3) GROUP BY the derived period, 4) Aggregations such as SUM for revenue and COUNT for transactions, 5) ORDER BY the period chronologically.',
    finalAnswer:
      "SELECT date_trunc('month', InvoiceDate) as month, COUNT(*) as sales_count, SUM(Total) as revenue FROM Invoice WHERE EXTRACT(year FROM InvoiceDate) = 2013 GROUP BY month ORDER BY month -- replace date_trunc/EXTRACT with your dialect's month/year helpers",
  },
  {
    originalQuestion: 'What are the best-selling tracks by genre?',
    stepBackQuestion:
      'What are the SQL principles for multi-dimensional aggregation with categories?',
    stepBackAnswer:
      'Multi-dimensional queries require: 1) Multiple JOINs to connect entities through foreign key relationships (Genre → Track → InvoiceLine), 2) GROUP BY all categorical dimensions you want to analyze (GenreId, TrackId), 3) Aggregation at the intersection of these dimensions (COUNT of sales per track per genre), 4) Proper table aliasing for query readability, 5) Understanding the data model relationships (which tables link to which).',
    finalAnswer:
      'SELECT g.Name as genre, t.Name as track, COUNT(*) as times_sold FROM Genre g JOIN Track t ON g.GenreId = t.GenreId JOIN InvoiceLine il ON t.TrackId = il.TrackId GROUP BY g.GenreId, t.TrackId ORDER BY times_sold DESC LIMIT 10',
  },
];

const text2sqlAgent = agent<
  { sql: string },
  {
    introspection: Introspection;
    context: string;
    adapterInfo: string;
    renderingTools?: RenderingTools;
    teachings: string;
    memory?: TeachablesStore;
    userId?: string;
  }
>({
  name: 'text2sql',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => {
    const renderingGuidance = getRenderingGuidance(state?.renderingTools);
    const hasMemory = !!state?.memory;
    const constraints = [
      '**Max Output Rows**: Never output more than 100 rows of raw data. Use aggregation or pagination otherwise.',
      '**Validation**: You must validate your query before final execution. Follow the pattern: Draft Query → `validate_query` → Fix (if needed) → `db_query`.',
      '**Data Inspection**: If you are unsure about column values (e.g. status codes, date formats), use `get_sample_rows` to inspect the data before writing the query.',
      '**Tool Usage**: If you have not produced a SQL snippet, do not call `db_query`. First produce the query string, then validate.',
      renderingGuidance.constraint,
      '**Scratchpad**: Use the `scratchpad` tool for strategic reflection during SQL query generation.',
    ].filter(Boolean);

    const constraintsSection = constraints
      .map((constraint, index) => `      ${index + 1}. ${constraint}`)
      .join('\n');

    return `
    <identity>
      You are an expert SQL query generator, answering business questions with accurate queries.
      Your tone should be concise and business-friendly.
    </identity>

    ${databaseSchemaPrompt(state!)}

    ${state?.teachings || ''}

    ${hasMemory ? memoryPrompt : ''}

    <query_reasoning_strategy>
      ${stepBackPrompt('general', {
        examples: SQL_STEP_BACK_EXAMPLES,
        stepBackQuestionTemplate:
          'What are the SQL patterns, database principles, and schema relationships needed to answer this question?',
      })}

      Skip Step-Back only if the question is a direct "SELECT * FROM …" or a simple aggregation with a clear target.
    </query_reasoning_strategy>

    <constraints>
${constraintsSection}
    </constraints>
${renderingGuidance.section}
  `;
  },
});

export const text2sqlOnly = text2sqlAgent.clone({
  tools: {},
  output: z.object({
    sql: z
      .string()
      .describe('The SQL query generated to answer the user question.'),
  }),
  prompt: (state) => {
    return `
    <identity>
      You are an expert SQL query generator, answering business questions with accurate queries.
      Your tone should be concise and business-friendly.
    </identity>

    ${databaseSchemaPrompt(state!)}

    <constraints>
      1. **Output**: Provide ONLY the SQL query. Do not include markdown formatting like \`\`\`sql ... \`\`\`.
      2. **Dialect**: Use standard SQL compatible with SQLite unless specified otherwise.
    </constraints>
  `;
  },
});

export const text2sqlMonolith = text2sqlAgent.clone({
  model: groq('openai/gpt-oss-20b'),
  // model: openai('gpt-5.1-codex'),
  tools,
});
