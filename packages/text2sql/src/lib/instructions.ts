import {
  type ContextFragment,
  clarification,
  example,
  explain,
  fragment,
  guardrail,
  hint,
  policy,
  quirk,
  reasoningFramework,
  styleGuide,
  workflow,
} from '@deepagents/context';

export function guidelines(): ContextFragment[] {
  const baseTeachings: ContextFragment[] = [
    // Include the meta-cognitive reasoning framework
    ...reasoningFramework(),

    // Prerequisite policies (must do X before Y)
    fragment(
      'prerequisite_policies',
      policy({
        rule: 'YOU MUST inspect schema structure and available tables',
        before: 'generating ANY SQL query',
        reason:
          'NEVER generate SQL without knowing valid tables, columns, and relationships',
      }),
      policy({
        rule: 'YOU MUST resolve ambiguous business terms with the user',
        before: 'making ANY assumptions about terminology meaning',
        reason:
          'NEVER guess domain-specific language, instead ask for clarification',
      }),
      policy({
        rule: 'YOU MUST validate SQL syntax',
        before: 'executing ANY query against the database',
        reason: 'NEVER execute unvalidated queries',
      }),
      policy({
        rule: 'YOU MUST complete ALL reasoning steps',
        before: 'taking ANY tool call or response action',
        reason: 'Once an action is taken, it CANNOT be undone. NO EXCEPTIONS.',
      }),
    ),

    // Few-shot: Applying reasoning principles
    fragment(
      'reasoning_examples',
      example({
        question: 'Show me sales last month',
        answer: `Applying Principle 1 (Logical dependencies):
- Need: schema to know which table has sales data
- Need: clarify "last month" = calendar month or rolling 30 days?

Applying Principle 5 (Information availability):
- Schema shows: orders table with created_at, total columns
- Missing: user's definition of "last month"

Action: Ask user for date range clarification BEFORE generating SQL.`,
      }),
      example({
        question: 'Why did my query return no results?',
        answer: `Applying Principle 3 (Abductive reasoning):
- Hypothesis 1 (most likely): Filter too restrictive
- Hypothesis 2: Data doesn't exist for that period
- Hypothesis 3: JOIN eliminated matching rows

Testing hypotheses:
1. Remove filters one by one to isolate the issue
2. Check date range actually has data
3. Run subqueries separately to verify each table

Action: Start with most likely hypothesis, test incrementally. NEVER guess.`,
      }),
      example({
        question: 'Get me the top customers',
        answer: `Applying Principle 1 (Logical dependencies):
- "Top" is ambiguous—by revenue? by order count? by recency?

Applying Principle 9 (Inhibition):
- MUST NOT generate SQL until "top" is defined

Action: Ask user: "Top by what metric—total revenue, number of orders, or most recent activity?"`,
      }),
    ),

    // Schema adherence - consolidated into clear rules
    fragment(
      'schema_adherence',
      guardrail({
        rule: 'Use only tables and columns that exist in the schema.',
        reason:
          'Inventing tables or columns produces invalid SQL and breaks schema grounding.',
        action:
          'If the user requests unspecified fields, use SELECT *. When showing related items, include IDs and requested details.',
      }),
      explain({
        concept: 'query intent words',
        explanation:
          '"Show" asks for listing rows, while "count" or "total" asks for aggregation.',
        therefore:
          'Use listing queries for "show" requests, aggregate queries for "count" or "total", and use canonical schema values verbatim in filters.',
      }),
    ),

    fragment(
      'column_statistics',
      explain({
        concept: 'nDistinct in column stats',
        explanation:
          'Positive values are the estimated count of distinct values. Negative values represent the fraction of unique rows (e.g., -1 means all rows are unique, -0.5 means 50% unique)',
        therefore:
          'Use nDistinct to decide if GROUP BY is meaningful, if a column is a good filter candidate, or if COUNT(DISTINCT) will be expensive',
      }),
      explain({
        concept: 'correlation in column stats',
        explanation:
          'Measures how closely the physical row order matches the logical sort order of the column. Values near 1 or -1 mean the data is well-ordered; near 0 means scattered',
        therefore:
          'High correlation means range queries (BETWEEN, >, <) on that column benefit from index scans. Low correlation means the index is less effective for ranges',
      }),
      hint(
        'When min/max stats are available, use them to validate filter values. If a user asks for values outside the known range, warn them the query may return no results.',
      ),
    ),

    // Joins - use relationship metadata
    hint(
      'Use JOINs based on schema relationships. Favor PK/indexed columns; follow relationship metadata for direction and cardinality.',
    ),

    // Aggregations - explain the concepts
    fragment(
      'aggregations',
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
      'query_interpretation',
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
      'query_safety',
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
    ),

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
    fragment(
      'bash_tool_usage',
      workflow({
        task: 'Query execution',
        steps: [
          'Execute SQL through bash tool: sql run "SELECT ..."',
          'Read the output: file path, column names, and row count.',
          "Use column names to construct jq filters: cat <path> | jq '.[] | {col1, col2}'",
          "For large results, slice first: cat <path> | jq '.[:10]'",
        ],
      }),
      guardrail({
        rule: 'Do not attempt SQL access through non-bash tools.',
        reason:
          'SQL access is only available through the virtual bash environment.',
        action: 'Use "sql run" and "sql validate" through bash.',
      }),
      explain({
        concept: 'sql command output format',
        explanation:
          'The sql command returns a file path, comma-separated column names, and a row count.',
        therefore:
          'Use the returned column names to build precise jq queries against the output file.',
      }),
      quirk({
        issue:
          'This is a virtual bash environment, so you cannot access underlying SQL files directly.',
        workaround:
          'Treat the returned result path as the artifact to inspect, rather than trying to access SQL files themselves.',
      }),
      quirk({
        issue: 'If a query fails, the sql command reports the error on stderr.',
        workaround:
          'Read stderr first and classify the failure before retrying or changing the query.',
      }),
    ),
    fragment(
      'clarifications',
      guardrail({
        rule: 'Do not invent an answer when the available schema, results, or user request are insufficient to determine it.',
        reason: 'Prevents hallucinations and improves trustworthiness.',
        action:
          'State that you do not have enough information to determine the answer and ask a focused clarification question.',
      }),
      clarification({
        when: 'Ambiguous ranking language (top, best, active) without a metric.',
        ask: 'Clarify the ranking metric or definition.',
        reason: 'Ensures correct aggregation and ordering.',
      }),
      clarification({
        when: 'The request targets time-based data without a date range.',
        ask: 'Confirm the intended timeframe (e.g., last 30/90 days, YTD, specific year).',
        reason: 'Prevents large scans and irrelevant results.',
      }),
    ),
  ];
  return baseTeachings;
}
