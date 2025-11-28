import { indentBlock, leaf, list, wrapBlock } from './xml.ts';

export interface Teachables {
  type:
    | 'term'
    | 'hint'
    | 'guardrail'
    | 'explain'
    | 'example'
    | 'clarification'
    | 'workflow'
    | 'quirk'
    | 'styleGuide'
    | 'analogy'
    | 'user_profile'
    // User-specific teachable types
    | 'role'
    | 'alias'
    | 'preference'
    | 'context'
    | 'correction';
  format: () => string;
}
export type GeneratedTeachable =
  | { type: 'term'; name: string; definition: string }
  | { type: 'hint'; text: string }
  | { type: 'guardrail'; rule: string; reason?: string; action?: string }
  | {
      type: 'explain';
      concept: string;
      explanation: string;
      therefore?: string;
    }
  | { type: 'example'; question: string; sql: string; note?: string }
  | { type: 'clarification'; when: string; ask: string; reason: string }
  | {
      type: 'workflow';
      task: string;
      steps: string[];
      triggers?: string[];
      notes?: string;
    }
  | { type: 'quirk'; issue: string; workaround: string }
  | { type: 'styleGuide'; prefer: string; never?: string; always?: string }
  | {
      type: 'analogy';
      concept: string[];
      relationship: string;
      insight?: string;
      therefore?: string;
      pitfall?: string;
    }
  // User-specific teachable types
  | { type: 'role'; description: string }
  | { type: 'alias'; term: string; meaning: string }
  | { type: 'preference'; aspect: string; value: string }
  | { type: 'context'; description: string }
  | { type: 'correction'; subject: string; clarification: string };

/**
 * Teach the system domain-specific vocabulary and business terminology.
 *
 * Use this to define simple, direct mappings between business terms and their meanings.
 * The system will understand these terms when users mention them in queries.
 *
 * @param name - The business term or acronym to define
 * @param definition - What the term means in your domain
 *
 * @example
 * // Logistics/Transportation dataset
 * term("deadhead miles", "distance driven with empty truck between deliveries")
 * term("dwell time", "total time a truck spends at a loading dock or warehouse")
 * term("LTL", "less than truckload - shipment that doesn't fill entire truck")
 *
 * @example
 * // Education/University dataset
 * term("matriculation", "students who completed enrollment and started classes")
 * term("DFW rate", "percentage of students receiving D, F, or Withdrawal in a course")
 * term("cohort", "group of students who entered the same semester or academic year")
 *
 * @example
 * // Finance/Banking dataset
 * term("NPL", "non-performing loan - loan past due 90+ days")
 * term("basis points", "one hundredth of a percentage point (1% = 100 bps)")
 * term("AUM", "assets under management - total market value of client investments")
 */
export function term(name: string, definition: string): Teachables {
  return {
    type: 'term',
    format: () =>
      wrapBlock('term', [leaf('name', name), leaf('definition', definition)]),
  };
}

/**
 * Teach the system behavioral rules and constraints that should always apply.
 *
 * Use this for business logic, data quality rules, or query preferences that should
 * be automatically applied to all relevant queries. Hints are injected as constraints
 * in the system prompt.
 *
 * @param text - The rule or constraint to follow (use imperative language)
 *
 * @example
 * // Manufacturing/Supply Chain dataset
 * hint("Always exclude work orders with status = 'simulation' from production metrics")
 * hint("When calculating OEE (overall equipment effectiveness), only count scheduled production time")
 * hint("Defect rates should be calculated per batch, not per individual unit, for consistency")
 *
 * @example
 * // Real Estate/Property dataset
 * hint("Never include properties with listing_status = 'draft' in market analysis")
 * hint("Always filter out duplicate MLS listings - use the earliest listing_date for each property_id")
 * hint("Square footage comparisons must specify if including or excluding basement/garage")
 *
 * @example
 * // Social Media/Content Platform dataset
 * hint("Engagement metrics should exclude bot accounts identified by is_verified_human = false")
 * hint("View counts reset daily - always use cumulative_views for historical analysis")
 * hint("Default content filters to published_status = 'public' unless analyzing drafts")
 */
export function hint(text: string): Teachables {
  return {
    type: 'hint',
    format: () => leaf('hint', text),
  };
}

/**
 * Define hard guardrails, safety rules, and compliance boundaries the system must enforce.
 *
 * Use this for "never do" rules, sensitive data handling, and required behaviors when
 * certain conditions occur. Guardrails should be explicit and action oriented.
 *
 * @param input.rule - The guardrail or restriction to enforce
 * @param input.reason - Why this guardrail exists (compliance, security, performance)
 * @param input.action - What to do when this guardrail is triggered (block, ask, sanitize)
 *
 * @example
 * // Healthcare dataset
 * guardrail({
 *   rule: "Never return PHI like SSN, MRN, or full address in query results",
 *   reason: "HIPAA compliance",
 *   action: "If asked, state that identifiable patient data cannot be shared; offer de-identified aggregates instead"
 * })
 *
 * @example
 * // Finance dataset
 * guardrail({
 *   rule: "Block any query exposing employee-level compensation by name",
 *   reason: "Confidential payroll data",
 *   action: "Provide ranges grouped by department or level instead of individual salaries"
 * })
 *
 * @example
 * // E-commerce dataset
 * guardrail({
 *   rule: "Warn when a query would scan more than 10 million rows; require a narrower date range",
 *   reason: "Performance and cost control",
 *   action: "Ask the user to add filters (recent timeframe, specific categories) before proceeding"
 * })
 */
export function guardrail(input: {
  rule: string;
  reason?: string;
  action?: string;
}): Teachables {
  const { rule, reason, action } = input;
  return {
    type: 'guardrail',
    format: () =>
      wrapBlock('guardrail', [
        leaf('rule', rule),
        reason ? leaf('reason', reason) : '',
        action ? leaf('action', action) : '',
      ]),
  };
}

/**
 * Teach the system a rich understanding of a single concept using metaphors and explanations.
 *
 * Use this when a simple term definition isn't enough - when you need to convey deeper
 * understanding about how to think about and calculate a metric or concept.
 *
 * @param input.concept - The concept being explained
 * @param input.explanation - A metaphor or detailed explanation (often using real-world comparisons)
 * @param input.therefore - Optional actionable instruction based on this understanding
 *
 * @example
 * // Gaming/Entertainment dataset
 * explain({
 *   concept: "daily active users to monthly active users ratio",
 *   explanation: "like measuring how many club members visit daily vs just once a month - shows stickiness",
 *   therefore: "Calculate as DAU / MAU, where higher ratio (closer to 1) means more engaged user base"
 * })
 *
 * @example
 * // HR/Employee Management dataset
 * explain({
 *   concept: "time to fill",
 *   explanation: "like measuring how long a house sits on the market - from posting job to accepting offer",
 *   therefore: "Calculate as days between job_posted_date and offer_accepted_date, exclude cancelled requisitions"
 * })
 *
 * @example
 * // Telecommunications dataset
 * explain({
 *   concept: "network congestion ratio",
 *   explanation: "like rush hour traffic density - measures actual usage vs total capacity at peak times",
 *   therefore: "Calculate as (peak_hour_bandwidth_used / total_bandwidth_capacity) during busiest hour of day"
 * })
 */
export function explain(input: {
  concept: string;
  explanation: string;
  therefore?: string;
}): Teachables {
  const { concept, explanation, therefore } = input;
  return {
    type: 'explain',
    format: () =>
      wrapBlock('explanation', [
        leaf('concept', concept),
        leaf('details', explanation),
        therefore ? leaf('therefore', therefore) : '',
      ]),
  };
}

/**
 * Teach the system through concrete examples of question → SQL pairs.
 *
 * Use this for few-shot learning - show the system exactly how to translate
 * specific types of questions into SQL queries. Great for establishing patterns
 * and handling domain-specific query structures.
 *
 * @param input.question - The natural language question or request
 * @param input.sql - The correct SQL query that answers the question
 * @param input.note - Optional note or explanation about the example
 *
 * @example
 * // Energy/Utilities dataset
 * example({
 *   question: "show me peak demand hours for the last week",
 *   sql: "SELECT DATE_TRUNC('hour', reading_timestamp) as hour, MAX(consumption_kwh) as peak_demand FROM meter_readings WHERE reading_timestamp >= CURRENT_DATE - INTERVAL '7 days' GROUP BY hour ORDER BY peak_demand DESC LIMIT 10"
 * })
 *
 * @example
 * // Agriculture/Farm Management dataset
 * example({
 *   question: "what is the average yield per acre by crop type this season",
 *   sql: "SELECT crop_type, AVG(harvest_quantity / field_acres) as yield_per_acre FROM harvests WHERE harvest_date >= '2024-01-01' GROUP BY crop_type ORDER BY yield_per_acre DESC"
 * })
 *
 * @example
 * // Travel/Hospitality dataset
 * example({
 *   question: "show me hotel occupancy rate for this month",
 *   sql: "SELECT hotel_name, (SUM(occupied_rooms) / SUM(total_rooms)) * 100 as occupancy_rate FROM daily_occupancy WHERE date >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY hotel_id, hotel_name ORDER BY occupancy_rate DESC",
 *   note: "Occupancy rate is a percentage - multiply by 100 for readable output"
 * })
 */
export function example(input: {
  question: string;
  sql: string;
  note?: string;
}): Teachables {
  const { question, sql, note } = input;
  return {
    type: 'example',
    format: () =>
      wrapBlock('example', [
        leaf('question', question),
        leaf('sql', sql),
        note ? leaf('note', note) : '',
      ]),
  };
}

/**
 * Teach the system when and what to ask for clarification.
 *
 * Use this to handle ambiguous terms or situations where the system should
 * proactively ask the user for more information before generating a query.
 * Makes the system more conversational and precise.
 *
 * @param input.when - The condition or trigger that should prompt clarification
 * @param input.ask - The question to ask the user
 * @param input.reason - Why this clarification is necessary (helps system understand importance)
 *
 * @example
 * // Marketing/Advertising dataset
 * clarification({
 *   when: "user asks for 'conversion rate'",
 *   ask: "Which conversion: click-to-lead, lead-to-opportunity, or opportunity-to-customer?",
 *   reason: "Conversion rate means different things at each funnel stage - need to specify which metric"
 * })
 *
 * @example
 * // Food Delivery dataset
 * clarification({
 *   when: "user asks about 'delivery time'",
 *   ask: "Do you mean estimated time at order, actual delivery time, or time from kitchen to door?",
 *   reason: "Multiple time metrics exist - estimated vs actual impacts customer satisfaction differently"
 * })
 *
 * @example
 * // Fitness/Gym Management dataset
 * clarification({
 *   when: "user mentions 'active members'",
 *   ask: "Do you mean paid memberships or members who actually visited in last 30 days?",
 *   reason: "Many paid members don't use facilities - different metrics for revenue vs utilization"
 * })
 */
export function clarification(input: {
  when: string;
  ask: string;
  reason: string;
}): Teachables {
  const { when, ask, reason } = input;
  return {
    type: 'clarification',
    format: () =>
      wrapBlock('clarification', [
        leaf('when', when),
        leaf('ask', ask),
        leaf('reason', reason),
      ]),
  };
}

/**
 * Teach the system multi-step analytical processes that can't be solved with a single query.
 *
 * Use this for complex analytical tasks that require multiple CTEs, sequential logic,
 * or specific methodologies. Workflows teach the system HOW to approach a type of analysis.
 *
 * @param input.task - Name of the analytical task
 * @param input.steps - Sequential steps to execute (can include SQL snippets or descriptions)
 * @param input.triggers - Optional phrases that should activate this workflow
 * @param input.notes - Optional additional context, warnings, or guidance
 *
 * @example
 * // Insurance dataset
 * workflow({
 *   task: "Claims Loss Ratio Analysis",
 *   triggers: ["loss ratio", "claims ratio", "underwriting performance"],
 *   steps: [
 *     "Calculate total claims paid for each policy period",
 *     "Calculate total premiums earned for same period",
 *     "Compute loss ratio as (claims_paid / premiums_earned) * 100",
 *     "Segment by policy type, geography, and underwriter",
 *     "Identify policies with loss ratio > 100% (losing money)",
 *     "Calculate trend over time using rolling 12-month windows"
 *   ],
 *   notes: "Use incurred date for claims, not paid date. Exclude reinsurance recoveries from claims total."
 * })
 *
 * @example
 * // Media/Publishing dataset
 * workflow({
 *   task: "Content Performance Funnel",
 *   triggers: ["content funnel", "engagement funnel", "content performance"],
 *   steps: [
 *     "Count total impressions (articles shown) per content piece",
 *     "Count click-throughs (articles opened)",
 *     "Count scroll depth > 50% (meaningful engagement)",
 *     "Count shares, comments, or saves (viral actions)",
 *     "Calculate conversion rate at each funnel stage",
 *     "Identify top-performing content by final conversion rate"
 *   ],
 *   notes: "Requires multiple event types. Join events table multiple times or use conditional aggregation."
 * })
 *
 * @example
 * // Sports Analytics dataset
 * workflow({
 *   task: "Player Performance Rating Calculation",
 *   triggers: ["player rating", "performance score", "player analytics"],
 *   steps: [
 *     "Aggregate per-game stats: points, assists, rebounds, turnovers",
 *     "Calculate efficiency metrics: shooting percentage, plus/minus",
 *     "Normalize each metric using z-scores vs league average",
 *     "Apply position-specific weights to each metric",
 *     "Combine weighted scores into overall performance rating (0-100)",
 *     "Rank players within position group and overall"
 *   ],
 *   notes: "Requires league-wide statistics for normalization. Update weights each season based on game trends."
 * })
 */
export function workflow(input: {
  task: string;
  steps: string[];
  triggers?: string[];
  notes?: string;
}): Teachables {
  const { task, steps, triggers, notes } = input;
  return {
    type: 'workflow',
    format: () =>
      wrapBlock('workflow', [
        leaf('task', task),
        triggers?.length ? list('triggers', triggers, 'trigger') : '',
        list('steps', steps, 'step'),
        notes ? leaf('notes', notes) : '',
      ]),
  };
}

/**
 * Teach the system about data quirks, edge cases, or database-specific issues and their workarounds.
 *
 * Use this to document weird data patterns, database limitations, or special handling
 * required for specific scenarios. Helps the system navigate real-world messiness.
 *
 * @param input.issue - Description of the quirk, edge case, or problem
 * @param input.workaround - How to handle or work around this issue
 *
 * @example
 * // Government/Public Services dataset
 * quirk({
 *   issue: "Citizen IDs contain leading zeros but are stored as integers, losing the zeros",
 *   workaround: "Always cast to VARCHAR and use LPAD(citizen_id::VARCHAR, 10, '0') to restore leading zeros"
 * })
 *
 * @example
 * // Aviation dataset
 * quirk({
 *   issue: "Flight times crossing midnight show as negative duration (landing before takeoff)",
 *   workaround: "Add 24 hours when calculated duration < 0: CASE WHEN duration < 0 THEN duration + INTERVAL '24 hours' ELSE duration END"
 * })
 *
 * @example
 * // Automotive/Dealership dataset
 * quirk({
 *   issue: "VIN numbers with letter 'O' were incorrectly entered as zero '0' in legacy data",
 *   workaround: "When searching by VIN, use REPLACE(vin, '0', 'O') or fuzzy matching to handle both cases"
 * })
 */
export function quirk(input: {
  issue: string;
  workaround: string;
}): Teachables {
  const { issue, workaround } = input;
  return {
    type: 'quirk',
    format: () =>
      wrapBlock('quirk', [
        leaf('issue', issue),
        leaf('workaround', workaround),
      ]),
  };
}

/**
 * Teach the system SQL style preferences and coding standards for generated queries.
 *
 * Use this to enforce consistent SQL formatting, naming conventions, and best practices
 * specific to your team or organization. Improves readability and maintainability.
 *
 * @param input.prefer - Preferred SQL style or pattern
 * @param input.never - Optional anti-pattern to avoid
 * @param input.always - Optional rule that must always be followed
 *
 * @example
 * // Non-profit/Charity dataset
 * styleGuide({
 *   prefer: "Use donor-centric language in column aliases: 'donor_name' not 'customer_name'",
 *   never: "Never expose internal donor IDs in external reports - use public gift IDs",
 *   always: "Always include fiscal year in date-based aggregations (FY starts July 1)"
 * })
 *
 * @example
 * // Legal/Law Firm dataset
 * styleGuide({
 *   prefer: "Use billable_hours with 2 decimal precision for accurate client billing",
 *   never: "Never include attorney_rate in queries visible to paralegals - confidential data",
 *   always: "Always filter by matter_status = 'open' unless specifically analyzing closed cases"
 * })
 *
 * @example
 * // Inventory/Warehouse dataset
 * styleGuide({
 *   prefer: "Use location_id in joins rather than location_name (duplicates exist across warehouses)",
 *   never: "Never aggregate inventory without grouping by warehouse_id first",
 *   always: "Always use inventory_on_hand - inventory_reserved for available stock calculations"
 * })
 */
export function styleGuide(input: {
  prefer: string;
  never?: string;
  always?: string;
}): Teachables {
  const { prefer, never, always } = input;
  return {
    type: 'styleGuide',
    format: () =>
      wrapBlock('style_guide', [
        leaf('prefer', prefer),
        always ? leaf('always', always) : '',
        never ? leaf('never', never) : '',
      ]),
  };
}

/**
 * Teach the system by comparing related concepts through real-world analogies.
 *
 * Use this to teach relational understanding between two concepts by drawing comparisons
 * to familiar real-world scenarios. Helps the system understand WHY concepts differ and
 * when to use each one appropriately.
 *
 * @param input.concept - Array of two related concepts to compare
 * @param input.relationship - The comparison/analogy using real-world examples
 * @param input.insight - Optional key insight the analogy reveals
 * @param input.therefore - Optional actionable instruction based on this understanding
 * @param input.pitfall - Optional common mistake to avoid
 *
 * @example
 * // E-commerce dataset
 * analogy({
 *   concept: ["cart abandonment", "browse abandonment"],
 *   relationship: "Cart abandonment is like leaving items at a checkout counter, browse abandonment is like window shopping without picking anything up",
 *   insight: "Cart abandonment shows purchase intent (added to cart), browse abandonment shows only interest",
 *   therefore: "Prioritize cart abandonment recovery campaigns - higher conversion potential than browse",
 *   pitfall: "Don't combine both into generic 'abandonment rate' - they need different marketing strategies"
 * })
 *
 * @example
 * // SaaS dataset
 * analogy({
 *   concept: ["logo churn", "revenue churn"],
 *   relationship: "Logo churn is like counting how many customers left the store, revenue churn is how much money walked out",
 *   insight: "Losing 10 small customers (high logo churn) might hurt less than losing 1 enterprise customer (high revenue churn)",
 *   therefore: "Always report both metrics - logo churn for customer satisfaction, revenue churn for financial health",
 *   pitfall: "Don't use logo churn to predict revenue impact - customer size distribution matters"
 * })
 *
 * @example
 * // Healthcare dataset
 * analogy({
 *   concept: ["incident", "prevalence"],
 *   relationship: "Incidence is like new house sales this month, prevalence is total houses currently occupied",
 *   insight: "Incidence measures new cases over time, prevalence measures all existing cases at a point in time",
 *   therefore: "For tracking disease outbreaks use incidence rate, for resource planning use prevalence",
 *   pitfall: "Don't sum incidence rates across time periods - it's a rate not a count"
 * })
 */
export function analogy(input: {
  concept: string[];
  relationship: string;
  insight?: string;
  therefore?: string;
  pitfall?: string;
}): Teachables {
  const { concept, relationship, insight, therefore, pitfall } = input;
  return {
    type: 'analogy',
    format: () =>
      wrapBlock('analogy', [
        list('concepts', concept, 'concept'),
        leaf('relationship', relationship),
        insight ? leaf('insight', insight) : '',
        therefore ? leaf('therefore', therefore) : '',
        pitfall ? leaf('pitfall', pitfall) : '',
      ]),
  };
}

// =============================================================================
// User-Specific Teachable Types
// =============================================================================

/**
 * Define the user's role, identity, or perspective.
 *
 * Use this to capture who the user is and what lens they view data through.
 * Helps tailor explanations, terminology, and focus areas.
 *
 * @param description - The user's role or identity
 *
 * @example
 * role("VP of Sales at Acme Corp")
 * role("Data analyst in the marketing team")
 * role("Executive - needs high-level summaries, not technical details")
 * role("Finance manager focused on cost optimization")
 */
export function role(description: string): Teachables {
  return {
    type: 'role',
    format: () => leaf('role', description),
  };
}

/**
 * Define user-specific term meanings and vocabulary.
 *
 * Use this when the user has their own definitions for terms that might
 * differ from standard or domain definitions. Like `term()` but personal.
 *
 * @param termName - The term the user uses
 * @param meaning - What the user means by this term
 *
 * @example
 * alias("revenue", "gross revenue before deductions, not net")
 * alias("active users", "users who logged in within the last 30 days")
 * alias("the big table", "the orders table")
 * alias("Q4", "October through December, not fiscal Q4")
 */
export function alias(termName: string, meaning: string): Teachables {
  return {
    type: 'alias',
    format: () =>
      wrapBlock('alias', [leaf('term', termName), leaf('meaning', meaning)]),
  };
}

/**
 * Define how the user prefers results presented.
 *
 * Use this to capture output formatting, style, and behavioral preferences
 * that should apply to all interactions with this user.
 *
 * @param aspect - What aspect of output this preference applies to
 * @param value - The user's preference
 *
 * @example
 * preference("date format", "YYYY-MM-DD")
 * preference("output style", "tables over charts unless trend data")
 * preference("detail level", "always show the SQL query in responses")
 * preference("row limit", "default to 50 rows unless I ask for more")
 * preference("explanation style", "brief and to the point")
 */
export function preference(aspect: string, value: string): Teachables {
  return {
    type: 'preference',
    format: () =>
      wrapBlock('preference', [leaf('aspect', aspect), leaf('value', value)]),
  };
}

/**
 * Define the user's current working focus or project.
 *
 * Use this to capture temporary context that helps inform defaults,
 * assumptions, and suggestions. Should be updated as focus changes.
 *
 * @param description - What the user is currently working on
 *
 * @example
 * context("Preparing Q4 board presentation")
 * context("Investigating drop in signups last week")
 * context("Working on EMEA regional analysis for strategy meeting")
 * context("Debugging discrepancy in revenue numbers")
 */
export function context(description: string): Teachables {
  return {
    type: 'context',
    format: () => leaf('context', description),
  };
}

/**
 * Record a correction the user made to previous understanding.
 *
 * Use this when the user corrects a misunderstanding about data, columns,
 * or business logic. Prevents repeating the same mistake.
 *
 * @param subject - What was misunderstood
 * @param clarification - The correct understanding
 *
 * @example
 * correction("status column", "1 = active, 0 = inactive, not boolean true/false")
 * correction("orders table", "Use orders_v2, not the deprecated legacy_orders table")
 * correction("date field", "order_date is when order was placed, ship_date is when shipped")
 * correction("revenue calculation", "Must exclude refunds and chargebacks")
 */
export function correction(subject: string, clarification: string): Teachables {
  return {
    type: 'correction',
    format: () =>
      wrapBlock('correction', [
        leaf('subject', subject),
        leaf('clarification', clarification),
      ]),
  };
}

export function teachable(
  tag: string,
  ...teachables: Teachables[]
): Teachables {
  return {
    type: 'user_profile',
    format: () => toInstructions(tag, ...teachables),
  };
}

export function toInstructions(
  tag: string,
  ...teachables: Teachables[]
): string {
  if (!teachables.length) {
    return '';
  }

  const grouped = new Map<Teachables['type'], Teachables[]>();
  for (const teachable of teachables) {
    const existing = grouped.get(teachable.type) ?? [];
    existing.push(teachable);
    grouped.set(teachable.type, existing);
  }

  const definedTypes = new Set(SECTION_ORDER.map((s) => s.type));

  const sections = SECTION_ORDER.map(({ type, tag }) => {
    const items = grouped.get(type);
    if (!items?.length) {
      return '';
    }
    const renderedItems = items
      .map((item) => item.format().trim())
      .filter(Boolean)
      .map((item) => indentBlock(item, 2))
      .join('\n');
    if (!renderedItems.length) {
      return '';
    }
    return `<${tag}>\n${renderedItems}\n</${tag}>`;
  }).filter((section): section is string => Boolean(section));

  // Render types not defined in SECTION_ORDER at the end
  for (const [type, items] of grouped) {
    if (definedTypes.has(type)) {
      continue;
    }
    const renderedItems = items
      .map((item) => item.format().trim())
      .filter(Boolean)
      .map((item) => indentBlock(item, 2))
      .join('\n');
    if (renderedItems.length) {
      sections.push(renderedItems);
    }
  }

  if (!sections.length) {
    return '';
  }

  const content = indentBlock(sections.join('\n'), 2);
  return `<${tag}>\n${content}\n</${tag}>`;
}

const SECTION_ORDER: Array<{ type: Teachables['type']; tag: string }> = [
  // User context (render first - most important for personalization)
  { type: 'role', tag: 'user_role' },
  { type: 'context', tag: 'user_context' },
  { type: 'preference', tag: 'user_preferences' },
  { type: 'alias', tag: 'user_vocabulary' },
  { type: 'correction', tag: 'user_corrections' },
  // Domain knowledge
  { type: 'guardrail', tag: 'guardrails' },
  { type: 'styleGuide', tag: 'style_guides' },
  { type: 'hint', tag: 'hints' },
  { type: 'clarification', tag: 'clarifications' },
  { type: 'workflow', tag: 'workflows' },
  { type: 'quirk', tag: 'quirks' },
  { type: 'term', tag: 'terminology' },
  { type: 'explain', tag: 'explanations' },
  { type: 'analogy', tag: 'analogies' },
  { type: 'example', tag: 'examples' },
];

export function toTeachables(generated: GeneratedTeachable[]): Teachables[] {
  return generated.map((item) => {
    switch (item.type) {
      case 'term':
        return term(item.name, item.definition);
      case 'hint':
        return hint(item.text);
      case 'guardrail':
        return guardrail({
          rule: item.rule,
          reason: item.reason,
          action: item.action,
        });
      case 'explain':
        return explain({
          concept: item.concept,
          explanation: item.explanation,
          therefore: item.therefore,
        });
      case 'example':
        return example({
          question: item.question,
          sql: item.sql,
          note: item.note,
        });
      case 'clarification':
        return clarification({
          when: item.when,
          ask: item.ask,
          reason: item.reason,
        });
      case 'workflow':
        return workflow({
          task: item.task,
          steps: item.steps,
          triggers: item.triggers,
          notes: item.notes,
        });
      case 'quirk':
        return quirk({
          issue: item.issue,
          workaround: item.workaround,
        });
      case 'styleGuide':
        return styleGuide({
          prefer: item.prefer,
          never: item.never,
          always: item.always,
        });
      case 'analogy':
        return analogy({
          concept: item.concept,
          relationship: item.relationship,
          insight: item.insight,
          therefore: item.therefore,
          pitfall: item.pitfall,
        });
      // User-specific teachable types
      case 'role':
        return role(item.description);
      case 'alias':
        return alias(item.term, item.meaning);
      case 'preference':
        return preference(item.aspect, item.value);
      case 'context':
        return context(item.description);
      case 'correction':
        return correction(item.subject, item.clarification);
    }
  });
}
