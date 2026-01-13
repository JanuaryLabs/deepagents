import type { ContextFragment } from '../fragments.ts';

/**
 * Domain knowledge fragment builders.
 *
 * These fragments capture domain-specific knowledge that can be injected
 * into AI prompts. Use with renderers (XML, Markdown, TOML, TOON) to format.
 *
 * @example
 * ```ts
 * import { term, hint, guardrail } from '@deepagents/context';
 *
 * context.set(
 *   term('NPL', 'non-performing loan'),
 *   hint('Always filter by status'),
 *   guardrail({ rule: 'Never expose PII' }),
 * );
 * ```
 */

/**
 * Define domain-specific vocabulary and business terminology.
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
export function term(name: string, definition: string): ContextFragment {
  return {
    name: 'term',
    data: { name, definition },
  };
}

/**
 * Define behavioral rules and constraints that should always apply.
 *
 * Use this for business logic, data quality rules, or query preferences that should
 * be automatically applied to all relevant queries.
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
export function hint(text: string): ContextFragment {
  return {
    name: 'hint',
    data: text,
  };
}

/**
 * Define hard guardrails, safety rules, and compliance boundaries.
 *
 * Use this for "never do" rules, sensitive data handling, and required behaviors when
 * certain conditions occur. Guardrails should be explicit and action-oriented.
 *
 * @param input.rule - The guardrail or restriction to enforce
 * @param input.reason - Why this guardrail exists (compliance, security, performance)
 * @param input.action - What to do when this guardrail is triggered
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
}): ContextFragment {
  return {
    name: 'guardrail',
    data: {
      rule: input.rule,
      ...(input.reason && { reason: input.reason }),
      ...(input.action && { action: input.action }),
    },
  };
}

/**
 * Define a rich understanding of a single concept using metaphors and explanations.
 *
 * Use this when a simple term definition isn't enough - when you need to convey deeper
 * understanding about how to think about and calculate a metric or concept.
 *
 * @param input.concept - The concept being explained
 * @param input.explanation - A metaphor or detailed explanation
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
}): ContextFragment {
  return {
    name: 'explain',
    data: {
      concept: input.concept,
      explanation: input.explanation,
      ...(input.therefore && { therefore: input.therefore }),
    },
  };
}

/**
 * Define concrete examples of question → answer pairs.
 *
 * Use this for few-shot learning - show the system exactly how to translate
 * specific types of questions. Great for establishing patterns.
 *
 * @param input.question - The natural language question or request
 * @param input.answer - The correct answer that responds to the question
 * @param input.note - Optional note or explanation about the example
 *
 * @example
 * // Energy/Utilities dataset
 * example({
 *   question: "show me peak demand hours for the last week",
 *   answer: "SELECT DATE_TRUNC('hour', reading_timestamp) as hour, MAX(consumption_kwh) as peak_demand FROM meter_readings WHERE reading_timestamp >= CURRENT_DATE - INTERVAL '7 days' GROUP BY hour ORDER BY peak_demand DESC LIMIT 10"
 * })
 *
 * @example
 * // Agriculture/Farm Management dataset
 * example({
 *   question: "what is the average yield per acre by crop type this season",
 *   answer: "SELECT crop_type, AVG(harvest_quantity / field_acres) as yield_per_acre FROM harvests WHERE harvest_date >= '2024-01-01' GROUP BY crop_type ORDER BY yield_per_acre DESC"
 * })
 *
 * @example
 * // Travel/Hospitality dataset
 * example({
 *   question: "show me hotel occupancy rate for this month",
 *   answer: "SELECT hotel_name, (SUM(occupied_rooms) / SUM(total_rooms)) * 100 as occupancy_rate FROM daily_occupancy WHERE date >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY hotel_id, hotel_name ORDER BY occupancy_rate DESC",
 *   note: "Occupancy rate is a percentage - multiply by 100 for readable output"
 * })
 */
export function example(input: {
  question: string;
  answer: string;
  note?: string;
}): ContextFragment {
  return {
    name: 'example',
    data: {
      question: input.question,
      answer: input.answer,
      ...(input.note && { note: input.note }),
    },
  };
}

/**
 * Define when and what to ask for clarification.
 *
 * Use this to handle ambiguous terms or situations where the system should
 * proactively ask the user for more information.
 *
 * @param input.when - The condition or trigger that should prompt clarification
 * @param input.ask - The question to ask the user
 * @param input.reason - Why this clarification is necessary
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
}): ContextFragment {
  return {
    name: 'clarification',
    data: {
      when: input.when,
      ask: input.ask,
      reason: input.reason,
    },
  };
}

/**
 * Define multi-step analytical processes that require sequential logic.
 *
 * Use this for complex analytical tasks that require multiple steps or specific
 * methodologies. Workflows teach the system HOW to approach a type of analysis.
 *
 * @param input.task - Name of the analytical task
 * @param input.steps - Sequential steps to execute
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
}): ContextFragment {
  return {
    name: 'workflow',
    data: {
      task: input.task,
      steps: input.steps,
      ...(input.triggers?.length && { triggers: input.triggers }),
      ...(input.notes && { notes: input.notes }),
    },
  };
}

/**
 * Define data quirks, edge cases, or database-specific issues and their workarounds.
 *
 * Use this to document weird data patterns, database limitations, or special handling
 * required for specific scenarios.
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
}): ContextFragment {
  return {
    name: 'quirk',
    data: {
      issue: input.issue,
      workaround: input.workaround,
    },
  };
}

/**
 * Define style preferences and coding standards.
 *
 * Use this to enforce consistent formatting, naming conventions, and best practices
 * specific to your team or organization.
 *
 * @param input.prefer - Preferred style or pattern
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
}): ContextFragment {
  return {
    name: 'styleGuide',
    data: {
      prefer: input.prefer,
      ...(input.never && { never: input.never }),
      ...(input.always && { always: input.always }),
    },
  };
}

/**
 * Define comparisons between related concepts through real-world analogies.
 *
 * Use this to teach relational understanding between concepts by drawing comparisons
 * to familiar real-world scenarios.
 *
 * @param input.concepts - Array of related concepts to compare
 * @param input.relationship - The comparison/analogy using real-world examples
 * @param input.insight - Optional key insight the analogy reveals
 * @param input.therefore - Optional actionable instruction
 * @param input.pitfall - Optional common mistake to avoid
 *
 * @example
 * // E-commerce dataset
 * analogy({
 *   concepts: ["cart abandonment", "browse abandonment"],
 *   relationship: "Cart abandonment is like leaving items at a checkout counter, browse abandonment is like window shopping without picking anything up",
 *   insight: "Cart abandonment shows purchase intent (added to cart), browse abandonment shows only interest",
 *   therefore: "Prioritize cart abandonment recovery campaigns - higher conversion potential than browse",
 *   pitfall: "Don't combine both into generic 'abandonment rate' - they need different marketing strategies"
 * })
 *
 * @example
 * // SaaS dataset
 * analogy({
 *   concepts: ["logo churn", "revenue churn"],
 *   relationship: "Logo churn is like counting how many customers left the store, revenue churn is how much money walked out",
 *   insight: "Losing 10 small customers (high logo churn) might hurt less than losing 1 enterprise customer (high revenue churn)",
 *   therefore: "Always report both metrics - logo churn for customer satisfaction, revenue churn for financial health",
 *   pitfall: "Don't use logo churn to predict revenue impact - customer size distribution matters"
 * })
 *
 * @example
 * // Healthcare dataset
 * analogy({
 *   concepts: ["incidence", "prevalence"],
 *   relationship: "Incidence is like new house sales this month, prevalence is total houses currently occupied",
 *   insight: "Incidence measures new cases over time, prevalence measures all existing cases at a point in time",
 *   therefore: "For tracking disease outbreaks use incidence rate, for resource planning use prevalence",
 *   pitfall: "Don't sum incidence rates across time periods - it's a rate not a count"
 * })
 */
export function analogy(input: {
  concepts: string[];
  relationship: string;
  insight?: string;
  therefore?: string;
  pitfall?: string;
}): ContextFragment {
  return {
    name: 'analogy',
    data: {
      concepts: input.concepts,
      relationship: input.relationship,
      ...(input.insight && { insight: input.insight }),
      ...(input.therefore && { therefore: input.therefore }),
      ...(input.pitfall && { pitfall: input.pitfall }),
    },
  };
}

/**
 * Map business terms directly to expressions or fragments.
 *
 * Use this to teach the system how to CALCULATE or QUERY specific business concepts.
 * The system will substitute these patterns when users mention the term.
 *
 * **Glossary vs Alias:**
 * - `alias` = user vocabulary → table/column name ("the big table" → "orders table")
 * - `glossary` = business term → SQL expression ("revenue" → "SUM(orders.total_amount)")
 *
 * In short: alias renames, glossary computes.
 *
 * @param entries - Record mapping business terms to their expressions
 *
 * @example
 * glossary({
 *   "revenue": "SUM(orders.total_amount)",
 *   "average order value": "AVG(orders.total_amount)",
 *   "active user": "last_login > NOW() - INTERVAL '30 days'",
 *   "churned": "status = 'churned'",
 *   "power user": "order_count > 10",
 *   "net revenue": "SUM(orders.total_amount) - SUM(refunds.amount)",
 * })
 */
export function glossary(entries: Record<string, string>): ContextFragment {
  return {
    name: 'glossary',
    data: Object.entries(entries).map(([term, expression]) => ({
      term,
      expression,
    })),
  };
}
