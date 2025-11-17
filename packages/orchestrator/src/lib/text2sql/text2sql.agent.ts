import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import z from 'zod';

import { type StepBackExample, agent, stepBackPrompt } from '@deepagents/agent';

import db from './db.ts';
import { formatError } from './sqlite.ts';

const tools = {
  validate_query: tool({
    description: `Validate SQL query syntax before execution. Use this to check if your SQL is valid before running db_query. This helps catch errors early and allows you to correct the query if needed.`,
    inputSchema: z.object({
      sql: z.string().describe('The SQL query to validate.'),
    }),
    execute: ({ sql }) => {
      try {
        db.prepare(sql);
        return {
          valid: true,
          message: 'Query syntax is valid',
        };
      } catch (error) {
        return JSON.stringify(formatError(sql, error));
      }
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
    execute: ({ sql }) => {
      try {
        const result = db.prepare(sql).all();
        return result;
      } catch (error) {
        return JSON.stringify(formatError(sql, error));
      }
    },
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
      "SELECT c.FirstName || ' ' || c.LastName as customer, SUM(i.Total) as total_spent FROM Customer c JOIN Invoice i ON c.CustomerId = i.CustomerId GROUP BY c.CustomerId ORDER BY total_spent DESC LIMIT 5",
  },
  {
    originalQuestion: 'Show me sales by month for 2013',
    stepBackQuestion:
      'What are the principles of time-based grouping and aggregation in SQL?',
    stepBackAnswer:
      "Time-based queries require: 1) Date extraction functions (strftime in SQLite) to extract time periods from timestamps, 2) WHERE clause to filter the date range, 3) GROUP BY the extracted time period (year-month), 4) Aggregation of metrics (SUM for revenue, COUNT for transaction count), 5) ORDER BY time period chronologically. In SQLite, use strftime('%Y-%m', date_column) for monthly grouping.",
    finalAnswer:
      "SELECT strftime('%Y-%m', InvoiceDate) as month, COUNT(*) as sales_count, SUM(Total) as revenue FROM Invoice WHERE strftime('%Y', InvoiceDate) = '2013' GROUP BY month ORDER BY month",
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

export type Introspection = {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
  }>;
  relationships: Array<{
    table: string;
    from: string[];
    referenced_table: string;
    to: string[];
  }>;
};

export const text2sqlAgent = agent<
  { sql: string },
  {
    schema: Introspection;
    context?: string;
  }
>({
  name: 'text2sql',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => `
    <database-schema>
      The database has the following tables with their columns and types:
      ${state?.schema.tables
        .map(
          (t) =>
            `- Table: ${t.name}\n  Columns:\n${t.columns.map((c) => `    - ${c.name} (${c.type})`).join('\n')}`,
        )
        .join('\n\n')}

      Relationships (foreign keys):
      ${
        state?.schema.relationships?.length
          ? state.schema.relationships
              .map(
                (r) =>
                  `- ${r.table} (${r.from.join(', ')}) -> ${r.referenced_table} (${r.to.join(', ')})`,
              )
              .join('\n')
          : 'None detected'
      }
    </database-schema>

    <database-context>
      ${state?.context}
    </database-context>

    <query_reasoning_strategy>
      ${stepBackPrompt('general', {
        examples: SQL_STEP_BACK_EXAMPLES,
        stepBackQuestionTemplate:
          'What are the SQL patterns, database principles, and schema relationships needed to answer this question?',
      })}
    </query_reasoning_strategy>

    <examples>
      Here are examples of how to handle different types of questions:

      Example 1 - Simple count:
      Q: "How many customers do we have?"
      SQL: SELECT COUNT(*) as total_customers FROM Customer
      Answer: "You have 59 customers in your database."

      Example 2 - Top results with aggregation:
      Q: "Who are our top 5 customers by spending?"
      SQL: SELECT c.FirstName || ' ' || c.LastName as customer_name, SUM(i.Total) as total_spent
           FROM Customer c JOIN Invoice i ON c.CustomerId = i.CustomerId
           GROUP BY c.CustomerId ORDER BY total_spent DESC LIMIT 5
      Answer: Present the list with context, e.g., "Your top 5 customers by total spending are..."

      Example 3 - Multiple table join:
      Q: "What are our best-selling tracks?"
      SQL: SELECT t.Name as track_name, COUNT(il.InvoiceLineId) as times_sold, SUM(il.UnitPrice * il.Quantity) as revenue
           FROM Track t JOIN InvoiceLine il ON t.TrackId = il.TrackId
           GROUP BY t.TrackId ORDER BY times_sold DESC LIMIT 10
      Answer: Present with business context about revenue or units sold

      Example 4 - Date-based query:
      Q: "How many sales did we have last year?"
      SQL: SELECT COUNT(*) as sales_count, SUM(Total) as total_revenue
           FROM Invoice WHERE strftime('%Y', InvoiceDate) = '2013'
      Answer: Combine count and revenue in a business-friendly way

      Example 5 - Clarification needed:
      Q: "Show me the best albums"
      Answer: Ask "Would you like to see albums by: number of tracks sold, total revenue, or something else?"

      Use these patterns as guidance for similar questions.
    </examples>
    <instructions>
      You help business owners understand their store data.

      REASONING FIRST (CRITICAL):
      Before writing SQL, apply step-back reasoning to ensure query correctness:
      1. Ask yourself: "What SQL patterns does this question require?" (JOINs, aggregations, filtering, time-based analysis, grouping, etc.)
      2. Identify: "What schema relationships and tables are involved?" (Check foreign keys and table connections)
      3. Consider: "What are the key database principles for this query type?" (Refer to the examples in query_reasoning_strategy)
      4. Plan: "What is the correct JOIN order and aggregation strategy?"
      5. Then construct your SQL query based on these foundational principles

      This step-back approach helps you:
      - Avoid common JOIN errors by understanding relationships first
      - Choose correct aggregation functions and GROUP BY clauses
      - Handle date filtering properly with SQLite's strftime function
      - Structure complex multi-table queries systematically

      SELF-CORRECTION PROCESS:
      When a query fails (validation or execution):
      1. Read the error message and error_type carefully
      2. Error types and how to fix them:
        - MISSING_TABLE: Check schema for correct table name (case-sensitive)
        - INVALID_COLUMN: Verify column exists in the table, use table prefix if ambiguous (e.g., c.CustomerId)
        - SYNTAX_ERROR: Review SQL syntax, check for missing commas, quotes, or keywords
        - INVALID_JOIN: Verify join columns exist and foreign key relationships are correct
        - CONSTRAINT_ERROR: Should not happen with read-only queries; review the query logic
      3. Check the database schema and context to find the correct names/relationships
      4. Generate a corrected query based on your analysis and the specific error type
      5. Try again (maximum 2 attempts total per user question)
      6. If still failing after 2 attempts, explain to user in plain language and suggest alternative approach

      HANDLING AMBIGUITY:
      If a question is unclear, ask for clarification before querying:
      - "Top customers" → Ask: "By total spending or number of purchases?"
      - "Recent sales" → Ask: "Last week, month, or year?"
      - "Best selling" → Ask: "By units sold or revenue?"

      SAFETY & QUALITY:
      - Always use LIMIT in queries (max 100 rows for lists)
      - For counts/aggregates, no LIMIT needed
      - Check database-context for actual value patterns before querying
      - Validate queries before executing them

      ANSWERING QUESTIONS:
      1. Query the data (use db_query tool)
      2. Present answer in plain business language
      3. Add helpful context (comparisons, insights)
      4. Suggest relevant follow-up question if appropriate

      Examples:
      Q: "How many albums do I have?"
      Bad: "SELECT COUNT(*) returned 347"
      Good: "You have 347 albums in your store from 275 different artists"

      Q: "Show me customers"
      Bad: Return raw 59 rows
      Good: Ask "Would you like to see all 59 customers, or filter by something specific (location, spending, etc.)?"

      Error handling:
      If query fails → "I couldn't get that data because [plain reason]. Try asking [alternative]."

      Remember: You're a helpful colleague, not a database expert.
    </instructions>
  `,
  output: z.object({
    sql: z
      .string()
      .describe('The SQL query generated to answer the user question.'),
  }),
});
