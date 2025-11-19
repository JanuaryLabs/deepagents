import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import z from 'zod';

import {
  type StepBackExample,
  agent,
  stepBackPrompt,
  toState,
} from '@deepagents/agent';

import type { Adapter, Introspection } from '../adapters/adapter.ts';
import { databaseSchemaPrompt } from '../prompt.ts';
import { synthesizerAgent } from './synthesizer.agent.ts';

const tools = {
  validate_query: tool({
    description: `Validate SQL query syntax before execution. Use this to check if your SQL is valid before running db_query. This helps catch errors early and allows you to correct the query if needed.`,
    inputSchema: z.object({
      sql: z.string().describe('The SQL query to validate.'),
    }),
    execute: ({ sql }, options) => {
      const state = toState<{ adapter: Adapter }>(options);
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
        .describe('The SQL query to execute against the database.'),
    }),
    execute: ({ sql }, options) => {
      const state = toState<{ adapter: Adapter }>(options);
      return state.adapter.execute(sql);
    },
  }),
  render_line_chart: tool({
    inputSchema: z.object({
      title: z.string().optional().describe('The title of the chart'),
      description: z
        .string()
        .optional()
        .describe('The description displayed below the title'),
      highlight: z
        .string()
        .optional()
        .describe('The highlighted trend or insight text'),
      detail: z
        .string()
        .optional()
        .describe('The detail text displayed in the footer'),
      xKey: z
        .string()
        .optional()
        .describe('The key from data points to use for X-axis values'),
      yKey: z
        .string()
        .optional()
        .describe('The key from data points to use for Y-axis values'),
      seriesLabel: z
        .string()
        .optional()
        .describe('The label for the data series in the legend'),
      color: z
        .string()
        .optional()
        .describe(
          'The CSS color variable for the line (e.g., "var(--chart-1)")',
        ),
      data: z
        .array(z.record(z.string(), z.union([z.string(), z.number()])))
        .optional()
        .describe('Array of data points, each with xKey and yKey properties'),
    }),
  }),
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
  }
>({
  name: 'text2sql',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => `
    <identity>
      You are an expert SQL query generator. Your task is to convert natural language questions into efficient and accurate SQL queries based on the provided database schema and context.
    </identity>

    ${databaseSchemaPrompt(state!)}

    <query_reasoning_strategy>
      ${stepBackPrompt('general', {
        examples: SQL_STEP_BACK_EXAMPLES,
        stepBackQuestionTemplate:
          'What are the SQL patterns, database principles, and schema relationships needed to answer this question?',
      })}
    </query_reasoning_strategy>

    <instructions>
      You help business owners understand their store data.

      DIALECT & SCHEMA HINTS:
      - Infer dialect from schema metadata/errors, then use matching quoting, concatenation, and date helpers.
      - LowCardinality annotations list canonical filter values; [rows / size] hints show when to aggregate vs. list individual rows.
      - PK/Indexed labels and the Indexes list point to efficient join/filter columns; column stats show value ranges and null rates.
      - Relationship entries already embed direction and rough cardinality—follow them for join order and lookup usage.

      REASONING PLAN:
      1. Translate the user question into required SQL patterns (aggregation, segmentation, time range, etc.).
      2. Choose tables/relations that satisfy the patterns; note lookup tables or filters implied by low-cardinality values.
      3. Sketch join/filter/aggregation order considering table sizes, indexes, and column stats.
      4. Write the SQL, then validate/execute via tools with a brief reasoning justification.

      ERROR RECOVERY:
      - On failures, inspect error_type: MISSING_TABLE/INVALID_COLUMN → fix identifiers; SYNTAX_ERROR → adjust structure; INVALID_JOIN → revisit relationships.
      - Re-run at most once after adjustments; if still failing, report the issue plainly and recommend an alternative query or clarification.

      AMBIGUITY:
      - Ask clarifying questions for vague inputs (“top” metric, time range, segmentation criteria) before querying.

      SAFETY & ANSWERS:
      - Limit raw lists to ≈100 rows; counts/aggregates need no LIMIT.
      - Validate when dialect uncertainty exists, and avoid unnecessary scans on huge tables.
      - Summaries should be in business language with key comparisons plus an optional helpful follow-up question.

     </instructions>

     <rendering_tools>
      You have access to a rendering tool that can create line charts from data. Use it to present trends clearly when appropriate.
     </rendering_tools>

  `,
});

export const text2sqlOnly = text2sqlAgent.clone({
  output: z.object({
    sql: z
      .string()
      .describe('The SQL query generated to answer the user question.'),
  }),
});

export const text2sqlMonolith = text2sqlAgent.clone({
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  tools,
});
