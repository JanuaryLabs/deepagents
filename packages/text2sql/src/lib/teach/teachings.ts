import {
  type Teachables,
  clarification,
  guardrail,
  hint,
  styleGuide,
  workflow,
} from './teachables.ts';

export interface TeachingsOptions {
  /**
   * Controls date/time clarification behavior:
   * - 'strict': Ask for clarification when date range is missing (production default)
   * - false: Skip date clarifications, assume all matching data (useful for evals/benchmarks)
   */
  date?: 'strict' | false;
}

export function guidelines(options: TeachingsOptions = {}): Teachables[] {
  const { date = 'strict' } = options;

  const baseTeachings: Teachables[] = [
    // Schema adherence
    hint(
      'Use only tables and columns that exist in the schema. Never reference non-existent entities.',
    ),
    hint(
      'If the user asks to show a table or entity without specifying columns, use SELECT *.',
    ),
    hint(
      'When showing items associated with another entity, include the item ID and the related details requested.',
    ),
    hint(
      'When asked to "show" items, list them unless the user explicitly asks to count or total.',
    ),
    hint(
      'Use canonical/LowCardinality values verbatim for filtering; [rows/size] hints suggest when to aggregate instead of listing.',
    ),

    // Joins and relationships
    hint(
      'Use appropriate JOINs based on the relationships defined in the schema.',
    ),
    hint(
      'Favor PK/indexed columns for joins and filters; follow relationship metadata for join direction and cardinality.',
    ),

    // Aggregations and calculations
    hint(
      'Apply proper aggregations (COUNT, SUM, AVG, etc.) when the question implies summarization.',
    ),
    hint(
      'When asked "how many X are there" about types/categories/statuses (e.g., "how many statuses are there?"), use COUNT(DISTINCT column). This asks about variety, not row count.',
    ),
    hint(
      'Use window functions when the question requires ranking, running totals, or comparisons across rows.',
    ),

    // Query semantics
    hint(
      'Words like "reach", "reached", "hit" with a value (e.g., "temperature reach 80") mean >= (greater than or equal), not = (exact match).',
    ),
    hint(
      'For "shared by" two groups or mutually exclusive conditions (e.g., population > 1500 AND < 500), use INTERSECT between separate queries. A single WHERE with contradictory AND returns nothing.',
    ),
    hint(
      'When filtering by a specific value from a joined table (e.g., "students who registered course statistics"), always include that WHERE condition. Do not omit mentioned filters.',
    ),
    hint(
      'Handle NULL values appropriately using IS NULL, IS NOT NULL, or COALESCE.',
    ),

    // Style and readability
    styleGuide({
      prefer:
        'Use meaningful aliases for tables and columns to improve readability.',
    }),
    styleGuide({
      prefer:
        'Summaries should be concise, business-friendly, highlight key comparisons, and add a short helpful follow-up when useful.',
    }),

    // Guardrails - Query safety
    guardrail({
      rule: 'Generate ONLY valid, executable SQL.',
      reason: 'Invalid SQL wastes resources and confuses users.',
      action: 'Validate syntax and schema references before returning.',
    }),
    guardrail({
      rule: 'Only generate SELECT statements (read-only queries).',
      reason: 'Prevents accidental data modification.',
      action:
        'Never generate INSERT, UPDATE, DELETE, DROP, or other DDL/DML statements.',
    }),
    guardrail({
      rule: 'Avoid unbounded scans on large tables.',
      reason: 'Protects performance and prevents runaway queries.',
      action:
        'Ensure filters are applied on indexed columns before querying broad fact tables.',
    }),
    guardrail({
      rule: 'Do not add LIMIT unless explicitly requested.',
      action:
        'Only add LIMIT when user explicitly asks for "top N", "first N", or similar. Do NOT add LIMIT for "list all", "show all", or simple "list" queries.',
      reason: 'Adding arbitrary limits changes query semantics.',
    }),
    guardrail({
      rule: 'Add ORDER BY where appropriate for deterministic results.',
      reason: 'Ensures consistent query output.',
      action:
        'Include ORDER BY when results have a natural ordering or when combined with LIMIT.',
    }),
    guardrail({
      rule: 'Prevent cartesian or guesswork joins.',
      reason: 'Protect correctness and performance.',
      action:
        'If join keys are missing or unclear, inspect relationships and ask for the intended join path before executing.',
    }),
    guardrail({
      rule: 'Ensure the query is optimized for the schema.',
      reason: 'Better performance and resource usage.',
      action:
        'Use indexed columns for filtering, avoid SELECT * on large joins, prefer specific column selection when appropriate.',
    }),
    guardrail({
      rule: 'When facing genuine ambiguity with multiple valid interpretations, seek clarification.',
      reason: 'Prevents incorrect assumptions in edge cases.',
      action:
        'Ask a focused clarifying question before proceeding with a guess.',
    }),

    // Clarifications
    clarification({
      when: 'The request uses ambiguous scoring or ranking language (e.g., "top", "best", "active") without a metric.',
      ask: 'Clarify the ranking metric or definition before writing the query.',
      reason: 'Ensures the correct aggregation/ordering is used.',
    }),

    // Workflow
    workflow({
      task: 'SQL generation plan',
      steps: [
        'Scan column names for terms matching the question. If a phrase like "total X" or "number of Y" matches a column name (e.g., Total_X, Num_Y), select that column directly instead of aggregating.',
        'Translate the question into SQL patterns (aggregation, segmentation, time range, ranking) only if no column name match.',
        'Choose tables/relations that satisfy those patterns; note lookup tables and filter values implied by schema hints.',
        'Sketch join/filter/aggregation order considering table sizes, indexes, and stats.',
        'Generate precise, validated SQL that answers the question.',
      ],
    }),
  ];

  // Date-specific clarifications (only when strict)
  if (date === 'strict') {
    baseTeachings.push(
      clarification({
        when: 'The request targets time-based data without a date range.',
        ask: 'Confirm the intended timeframe (e.g., last 30/90 days, YTD, specific year).',
        reason: 'Prevents large scans and irrelevant results.',
      }),
    );
  } else {
    // When date is false, assume all matching data without asking
    baseTeachings.push(
      hint(
        'When a month, day, or time period is mentioned without a year (e.g., "in August", "on Monday"), assume ALL occurrences of that period in the data. Do not ask for year clarification.',
      ),
    );
  }

  return baseTeachings;
}
