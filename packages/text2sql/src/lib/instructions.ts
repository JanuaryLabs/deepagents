import {
  type ContextFragment,
  clarification,
  explain,
  fragment,
  guardrail,
  hint,
  quirk,
  styleGuide,
  workflow,
} from '@deepagents/context';

export interface TeachingsOptions {
  /**
   * Controls date/time clarification behavior:
   * - 'strict': Ask for clarification when date range is missing (production default)
   * - false: Skip date clarifications, assume all matching data (useful for evals/benchmarks)
   */
  date?: 'strict' | false;
}

export function guidelines(options: TeachingsOptions = {}): ContextFragment[] {
  const { date = 'strict' } = options;

  const baseTeachings: ContextFragment[] = [
    // Schema adherence - consolidated into clear rules
    fragment(
      'Schema adherence',
      hint(
        'Use only tables and columns from the schema. For unspecified columns, use SELECT *. When showing related items, include IDs and requested details.',
      ),
      hint(
        '"Show" means list items; "count" or "total" means aggregate. Use canonical values verbatim for filtering.',
      ),
    ),

    // Joins - use relationship metadata
    hint(
      'Use JOINs based on schema relationships. Favor PK/indexed columns; follow relationship metadata for direction and cardinality.',
    ),

    // Aggregations - explain the concepts
    fragment(
      'Aggregations',
      hint(
        'Apply COUNT, SUM, AVG when the question implies summarization. Use window functions for ranking, running totals, or row comparisons.',
      ),
      explain({
        concept: 'counting variety vs counting rows',
        explanation:
          '"How many types/categories/statuses exist?" asks about variety (unique values), not total row count',
        therefore: 'Use COUNT(DISTINCT column) for variety questions',
      }),
    ),

    // Query semantics - explain concepts and document quirks
    fragment(
      'Query interpretation',
      explain({
        concept: 'threshold language',
        explanation:
          'Words like "reach", "hit", "exceed" with a value imply a threshold being met or passed',
        therefore:
          'Translate to >= (greater than or equal), not = (exact match)',
      }),
      quirk({
        issue:
          'Contradictory WHERE conditions (e.g., value > 100 AND value < 50) return empty results',
        workaround:
          'Use INTERSECT between separate queries when finding items "shared by" groups with mutually exclusive conditions',
      }),
      quirk({
        issue:
          'NULL values behave unexpectedly in comparisons and aggregations',
        workaround:
          'Use IS NULL, IS NOT NULL, or COALESCE() to handle NULLs explicitly',
      }),
      hint(
        'Always include mentioned filters from joined tables in WHERE conditions.',
      ),
    ),

    // Style preferences
    styleGuide({
      prefer:
        'Full table names as aliases (users AS users). Descriptive column aliases (COUNT(*) AS total_count).',
      never:
        'Abbreviated aliases (u, oi) or positional aliases (t1, t2, a, b).',
    }),
    styleGuide({
      prefer:
        'Concise, business-friendly summaries with key comparisons and helpful follow-ups.',
    }),

    // Safety guardrails - consolidated
    fragment(
      'Query safety',
      guardrail({
        rule: 'Generate only valid, executable SELECT/WITH statements.',
        reason: 'Read-only access prevents data modification.',
        action:
          'Never generate INSERT, UPDATE, DELETE, DROP, or DDL statements.',
      }),
      guardrail({
        rule: 'Avoid unbounded scans and cartesian joins.',
        reason: 'Protects performance and correctness.',
        action:
          'Apply filters on indexed columns. If join keys are unclear, ask for clarification.',
      }),
      guardrail({
        rule: 'Preserve query semantics.',
        reason: 'Arbitrary modifications change results.',
        action:
          'Only add LIMIT for explicit "top N" requests. Add ORDER BY for deterministic results.',
      }),
      guardrail({
        rule: 'Seek clarification for genuine ambiguity.',
        reason: 'Prevents incorrect assumptions.',
        action: 'Ask a focused question before guessing.',
      }),
    ),

    clarification({
      when: 'Ambiguous ranking language (top, best, active) without a metric.',
      ask: 'Clarify the ranking metric or definition.',
      reason: 'Ensures correct aggregation and ordering.',
    }),

    hint(
      'Use sample cell values from schema hints to match exact casing and format in WHERE conditions (e.g., "Male" vs "male" vs "M").',
    ),

    workflow({
      task: 'SQL generation',
      steps: [
        'Schema linking: identify which tables and columns are mentioned or implied by the question.',
        'Check if column names match question terms (e.g., Total_X). Select directly if match found.',
        'Identify SQL patterns needed: aggregation, segmentation, time range, ranking.',
        'Select tables and relationships. Note lookup tables and filter values from schema.',
        'Plan join/filter/aggregation order based on table sizes and indexes.',
        'Generate SQL that answers the question.',
        'Verify: mentally translate SQL back to natural language. Does it match the original question?',
      ],
    }),

    workflow({
      task: 'Error recovery',
      triggers: ['SQL error', 'query failed', 'execution error'],
      steps: [
        'Classify the error type: syntax error, missing join, wrong aggregation, invalid column, type mismatch.',
        'For syntax errors: check SQL keywords, quotes, parentheses balance.',
        'For missing join: identify unlinked tables and add appropriate JOIN clause.',
        'For wrong aggregation: verify GROUP BY includes all non-aggregated SELECT columns.',
        'For invalid column: re-check schema for correct column name and table.',
        'Apply targeted fix based on error classification. Avoid blind regeneration.',
      ],
      notes:
        'Maximum 3 retry attempts. If still failing, explain the issue to the user.',
    }),

    workflow({
      task: 'Complex query decomposition',
      triggers: [
        'multiple conditions',
        'nested requirements',
        'compare across',
        'for each',
      ],
      steps: [
        'Identify if question has multiple independent parts or nested dependencies.',
        'For independent parts: break into sub-questions, solve each, then combine with UNION or JOIN.',
        'For nested dependencies: solve inner requirement first, use result in outer query (subquery or CTE).',
        'For comparisons across groups: use window functions or self-joins.',
        'Combine sub-results into final answer. Verify completeness.',
      ],
      notes:
        'Complex questions often need CTEs (WITH clauses) for clarity and reusability.',
    }),

    workflow({
      task: 'Multi-turn context',
      triggers: ['follow-up', 'and also', 'what about', 'same but', 'instead'],
      steps: [
        'Identify references to previous context: "it", "that", "those", "the same".',
        'Resolve references using conversation history: which tables, filters, or results were mentioned.',
        'For refinements ("but only X"): add filter to previous query.',
        'For extensions ("and also Y"): expand SELECT or add JOIN.',
        'For pivots ("what about Z instead"): replace the changed element, keep unchanged parts.',
        'Maintain consistency with previous query structure when possible.',
      ],
      notes:
        'If reference is ambiguous, ask which previous result or entity the user means.',
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
