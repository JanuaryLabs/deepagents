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
import { databaseSchemaPrompt } from '../prompt.ts';

export type RenderingTools = Record<string, Tool>;

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
      tableName: z
        .string()
        .transform((name) => name.replace(/[^a-zA-Z0-9_.]/g, ''))
        .describe('The name of the table to sample.'),
    }),
    execute: ({ tableName }, options) => {
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
    renderingTools: RenderingTools;
  }
>({
  name: 'text2sql',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => {
    const renderingGuidance = getRenderingGuidance(state?.renderingTools);
    const constraints = [
      '**Max Output Rows**: Never output more than 100 rows of raw data. Use aggregation or pagination otherwise.',
      '**Validation**: You must validate your query before final execution. Follow the pattern: Draft Query → `validate_query` → Fix (if needed) → `db_query`.',
      '**Data Inspection**: If you are unsure about column values (e.g. status codes, date formats), use `get_sample_rows` to inspect the data before writing the query.',
      '**Tool Usage**: If you have not produced a SQL snippet, do not call `db_query`. First produce the query string, then validate.',
    ];

    if (renderingGuidance.constraint) {
      constraints.push(renderingGuidance.constraint);
    }

    constraints.push(
      '**Scratchpad**: Use the `scratchpad` tool for strategic reflection during SQL query generation.',
    );

    const constraintsSection = constraints
      .map((constraint, index) => `      ${index + 1}. ${constraint}`)
      .join('\n');

    return `
    <identity>
      You are an expert SQL query generator, answering business questions with accurate queries.
      Your tone should be concise and business-friendly.
    </identity>

    ${databaseSchemaPrompt(state!)}

    <query_reasoning_strategy>
      ${stepBackPrompt('general', {
        examples: SQL_STEP_BACK_EXAMPLES,
        stepBackQuestionTemplate:
          'What are the SQL patterns, database principles, and schema relationships needed to answer this question?',
      })}

      Skip Step-Back only if the question is a direct “SELECT * FROM …” or a simple aggregation with a clear target.
    </query_reasoning_strategy>

    <constraints>
${constraintsSection}
    </constraints>

    <instructions>
      You help business owners understand their store data.

      DIALECT & SCHEMA HINTS:
      - LowCardinality annotations list canonical filter values; [rows / size] hints show when to aggregate vs. list individual rows.
      - PK/Indexed labels and the Indexes list point to efficient join/filter columns; column stats show value ranges and null rates.
      - Relationship entries already embed direction and rough cardinality—follow them for join order and lookup usage.

      REASONING PLAN:
      1. Translate the user question into required SQL patterns (aggregation, segmentation, time range, etc.).
      2. Choose tables/relations that satisfy the patterns; note lookup tables or filters implied by low-cardinality values.
      3. Inspect data samples using 'get_sample_rows' if column values are ambiguous (e.g. date formats, status codes).
      4. Sketch join/filter/aggregation order considering table sizes, indexes, and column stats.
      5. Write the SQL, then validate via 'validate_query', and finally execute via 'db_query' with a brief reasoning justification.

      ERROR RECOVERY:
      - On failures, inspect error_type: MISSING_TABLE/INVALID_COLUMN → fix identifiers; SYNTAX_ERROR → adjust structure; INVALID_JOIN → revisit relationships.
      - Re-run at most once after adjustments; if still failing, report the issue plainly and recommend an alternative query or clarification.

      AMBIGUITY:
      - If a user question is ambiguous (e.g., “top X”, missing time range), first ask for clarification before generating a query.

      SAFETY & ANSWERS:
      - Limit raw lists to ≈100 rows; counts/aggregates need no LIMIT.
      - Summaries should be in business language with key comparisons plus an optional helpful follow-up question.
    </instructions>
${renderingGuidance.section}
    <working_memory>
      You have access to a scratchpad tool for strategic reflection during SQL query generation.

      Use it to:
      - Record your analysis of the database schema and relationships
      - Note query optimization strategies you're considering
      - Track intermediate findings from query results
      - Document reasoning about join strategies and aggregations
      - Plan complex multi-step queries

      Call the scratchpad tool after analyzing schema or results to ensure deliberate, high-quality decision-making.
    </working_memory>
  `;
  },
});

export const text2sqlOnly = text2sqlAgent.clone({
  output: z.object({
    sql: z
      .string()
      .describe('The SQL query generated to answer the user question.'),
  }),
});

export const text2sqlMonolith = text2sqlAgent.clone({
  model: groq('openai/gpt-oss-20b'),
  // model: openai('gpt-5.1-codex'),
  tools,
});
