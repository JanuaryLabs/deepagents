import {
  type Teachables,
  clarification,
  guardrail,
  hint,
  styleGuide,
  workflow,
} from './teachables.ts';

export default [
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
  hint(
    'Favor PK/indexed columns for joins and filters; follow relationship metadata for join direction and cardinality.',
  ),
  guardrail({
    rule: 'Avoid unbounded scans on large/time-based tables.',
    action:
      'Ask for or apply a reasonable recent date range before querying broad fact tables.',
  }),
  guardrail({
    rule: 'Do not return oversized raw result sets.',
    action:
      'Keep raw limit strictly to ~100 rows even if users request more or coearced by hints.',
    reason:
      'Browser will time out or crash on huge datasets. Data overload harms usability.',
  }),
  guardrail({
    rule: 'Prevent cartesian or guesswork joins.',
    reason: 'Protect correctness and performance.',
    action:
      'If join keys are missing or unclear, inspect relationships and ask for the intended join path before executing.',
  }),
  clarification({
    when: 'The request targets time-based data without a date range.',
    ask: 'Confirm the intended timeframe (e.g., last 30/90 days, YTD, specific year).',
    reason: 'Prevents large scans and irrelevant results.',
  }),
  clarification({
    when: 'The request uses ambiguous scoring or ranking language (e.g., "top", "best", "active") without a metric.',
    ask: 'Clarify the ranking metric or definition before writing the query.',
    reason: 'Ensures the correct aggregation/ordering is used.',
  }),
  workflow({
    task: 'SQL generation plan',
    steps: [
      'Translate the question into SQL patterns (aggregation, segmentation, time range, ranking).',
      'Choose tables/relations that satisfy those patterns; note lookup tables and filter values implied by schema hints.',
      "Inspect samples with 'get_sample_rows' for any column you'll use in WHERE/JOIN conditions - target just those columns (e.g., get_sample_rows('orders', ['status', 'order_type'])).",
      'Sketch join/filter/aggregation order considering table sizes, indexes, and stats.',
      "Draft SQL, validate via 'validate_query', then execute via 'db_query' with a short reasoning note.",
    ],
  }),
  styleGuide({
    prefer:
      'Summaries should be concise, business-friendly, highlight key comparisons, and add a short helpful follow-up when useful.',
  }),
  // Tool usage constraints
  guardrail({
    rule: 'You must validate your query before final execution.',
    action:
      'Follow the pattern: Draft Query → `validate_query` → Fix (if needed) → `db_query`.',
  }),
  guardrail({
    rule: 'ALWAYS use `get_sample_rows` before writing queries that filter or compare against string columns.',
    reason: 'Prevents SQL errors from wrong value formats.',
    action:
      "Target specific columns (e.g., get_sample_rows('table', ['status', 'type'])).",
  }),
  guardrail({
    rule: 'Do not call `db_query` without first producing and validating a SQL snippet.',
    action: 'First produce the query string, then validate.',
  }),
  hint(
    'Use the `scratchpad` tool for strategic reflection during SQL query generation.',
  ),
] as Teachables[];
