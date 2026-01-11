---
name: report
description: "Generate comprehensive data analysis reports from database queries. Use when: (1) User asks for analysis, insights, or reports on data, (2) User wants to explore what's interesting in their database, (3) User needs metrics, KPIs, or business intelligence. Triggers on: analyze, report, insights, metrics, exploration, what's interesting, summarize data, dashboard."
---

# Data Report Generation

Generate comprehensive data analysis reports. This skill covers **workflow selection** (choosing the right approach), **data exploration** (finding what's interesting), and **report synthesis** (presenting findings clearly).

## The Foundation: Data Forward

```
// THE TRUTH ABOUT DATA REPORTS
report.value = {
  raw_numbers:    20%,    // tables, counts, sums
  context:        40%,    // comparisons, benchmarks
  insights:       90%     // "this matters because..."
}

// EVERY REPORT IS A STORY
report != query_dump
report == narrative(observation -> investigation -> conclusion)

// DATA FORWARD PHILOSOPHY
approach = {
  let_data_lead:    "What is the data actually saying?",
  anomaly_hunting:  "What's unexpected or unusual?",
  auto_deep_dive:   "When something's off, investigate immediately",
  structured_output: "Executive summary always included"
}

// LLM JUDGMENT IS KEY
anomaly_detection = llm.decides({
  is_this_unusual:    context_dependent,
  worth_investigating: business_relevance,
  how_deep_to_go:     no_arbitrary_limit
})
```

## Quick Start

```
// MINIMAL VIABLE REPORT
1. introspect(schema)           // what tables exist?
2. query(high_level_metrics)    // counts, totals, ranges
3. identify(interesting_patterns)
4. deep_dive(anomalies)         // no depth limit
5. write(findings)              // incremental output
6. summarize(key_takeaways)     // always include
```

## Workflow Selection

```
// LLM DISCRETION: CHOOSE THE RIGHT WORKFLOW
workflow.select = match(user_request) {
  "what's interesting?"     => exploration,
  "why did X happen?"       => focused,
  "A vs B"                  => comparison,
  "how has X changed?"      => trend
}
```

### Exploration

```
// AD-HOC DISCOVERY - open-ended questions, finding unknowns
flow = [
  scan(all_tables),           // what data exists?
  profile(key_metrics),       // distributions, ranges
  investigate(outliers),      // anything unusual?
  surface(patterns),          // correlations, clusters
  highlight(opportunities)    // actionable findings
]
// OUTPUT: broad findings, multiple potential stories
```

### Focused Analysis

```
// SINGLE-QUESTION DEEP DIVE - specific hypotheses, answering "why"
flow = [
  define(question),           // what exactly are we asking?
  identify(relevant_data),    // which tables matter?
  query(primary_metrics),     // direct answer
  investigate(causes),        // dig into drivers
  validate(conclusions)       // sanity check
]
// OUTPUT: focused answer with supporting evidence
```

### Comparison

```
// A VS B ANALYSIS - segments, time periods, variants
flow = [
  define(groups),             // what are we comparing?
  align(metrics),             // same measures for each
  calculate(differences),     // deltas, ratios
  test(significance),         // is it meaningful?
  explain(drivers)            // why the difference?
]
// OUTPUT: clear winner/loser with explanation
```

### Trend Analysis

```
// TIME-SERIES - tracking changes, forecasting, seasonality
flow = [
  define(time_range),         // what period?
  extract(time_series),       // data over time
  detect(patterns),           // trends, seasonality
  identify(anomalies),        // sudden changes
  explain(inflection_points)  // what caused changes?
]
// OUTPUT: trajectory with key events annotated
```

## Output Structure

```
// FILES WRITTEN TO ./report/ IN CURRENT DIRECTORY
output.location = "./report/"

// LLM DECIDES ORGANIZATION
structure.options = [
  section_per_file,     // executive.md, findings.md, appendix.md
  topic_per_file,       // revenue.md, users.md, performance.md
  single_append         // report.md (append as you go)
]

// INCREMENTAL WRITING - don't wait until the end
for each finding in analysis:
  append_to_file(finding)
  continue_investigation()
```

## Data Formatting

### Tables

```markdown
| Metric | Value | Change | Context |
|--------|-------|--------|---------|
| Revenue | $1.2M | +15% | vs last month |
| Users | 45,230 | -3% | expected seasonal |
| Conversion | 4.2% | +0.8pp | best in 6 months |

// RULES:
// - Always include context column when comparing
// - Use appropriate units ($, %, pp, K, M)
```

### ASCII Charts

```
Revenue by Month:
Jan ████████████ $120K
Feb ██████████████ $140K
Mar ████████████████████ $200K (+43%)
Apr ██████████████████████████ $260K (+30%)
May ████████ $80K (!!! -69%)   ← investigate this

// USE: quick visual in markdown
// AVOID: when precision needed or many data points
```

### Key Numbers Summary

```
// TOP-OF-REPORT SNAPSHOT (max 5-7 metrics)
| | Current | Previous | Change |
|---|---------|----------|--------|
| Total Revenue | $4.2M | $3.8M | +10.5% |
| Active Users | 127K | 115K | +10.4% |
| Avg Order Value | $47.30 | $52.10 | -9.2% |
```

## Finding Management

### Deep Dive Behavior

```
// WHEN ANOMALY FOUND: INVESTIGATE IMMEDIATELY
// NO DEPTH LIMIT - FOLLOW THE THREAD

on anomaly_detected:
  while not_explained(anomaly):
    hypothesis = generate_hypothesis()
    evidence = query_for_evidence(hypothesis)

    if evidence.confirms(hypothesis):
      document_finding(cause, evidence)
      break
    elif evidence.reveals(new_anomaly):
      push_stack(new_anomaly)  // nested investigation
    else:
      try_next_hypothesis()

// EXAMPLE:
// Found: Revenue dropped 30% in March
// -> Query by region -> All regions similar
// -> Query by product -> Product X down 80%
// -> Query Product X by day -> March 15 cliff
// -> Query events -> Price increase March 15
// -> FINDING: Price increase caused 80% drop in Product X
```

### Empty Results Handling

```
// EMPTY RESULTS ARE DATA TOO
on empty_result(query):
  document("No data found for: {query}")
  investigate_why()        // table exists? date range? filter?
  report_gap(explanation)
  continue_analysis()      // don't stop

// EXAMPLE: "No users from Antarctica (expected - no operations)"
```

### Contradiction Handling

```
// WHEN DATA CONTRADICTS ITSELF
on contradiction_detected(fact_a, fact_b):
  investigate_both_sources()
  check_definitions()      // same metric defined differently?
  check_time_alignment()   // different periods?

  if resolved:
    document("Contradiction resolved: {explanation}")
  else:
    report_both({
      finding_a, finding_b,
      confidence: "low - conflicting data",
      recommendation: "manual verification needed"
    })
// NEVER: silently pick one
// ALWAYS: document the uncertainty
```

## Executive Summary

```
// ALWAYS INCLUDE - FIRST THING READERS SEE
// WRITE LAST (after all analysis complete)

## Key Takeaways

**Top Finding:** [Most significant discovery]
Revenue grew 15% YoY, driven entirely by new customer acquisition.
Existing customer revenue actually declined 3%.

**Concern:** [Issue requiring attention]
Customer retention dropped to 67% (from 78% last quarter).
If trend continues, growth will stall in Q3.

**Opportunity:** [Actionable insight]
Product bundle customers retain at 89%.
Expanding bundle offering could recover 8-10pp retention.

**Next Steps:** [Recommended follow-up]
1. Deep dive on retention drivers (churn analysis)
2. Model bundle expansion impact
3. Review pricing strategy for existing customers
```

## Anti-Patterns

```
// DON'T DO THIS

query_dump = report(raw_sql_results: 50)
// -> Synthesize into narrative findings

no_context = metric(value: "$1.2M")
// -> Always compare: vs last period, vs target, vs benchmark

buried_insight = page_10_of_report(key_finding)
// -> Executive summary up front

investigation_abandoned = anomaly(status: "noted")
// -> Deep dive until explained or documented as unknown

false_precision = metric(value: "34.2847%")
// -> Round appropriately: "34%"

wall_of_numbers = table(rows: 500)
// -> Summarize, highlight top/bottom, link to appendix
```

## Templates

Ready-to-use workflow templates in [templates/](templates/):

- `exploration.md` - Open-ended data discovery
- `focused.md` - Single-question deep analysis
- `comparison.md` - A vs B segment analysis
- `trend.md` - Time-series analysis

## Pattern Library

Common analysis patterns in [references/patterns/](references/patterns/):

- Cohort analysis patterns
- Funnel breakdown patterns
- Segmentation patterns
- Anomaly investigation patterns

## Edge Cases

```
// LARGE SCHEMAS (>50 tables)
on large_schema:
  identify_relevant_tables(user_question)
  focus_on_subset(max: 10_tables)
  document_scope("Analysis limited to: {tables}")
// NEVER: try to analyze everything

// EMPTY TABLES
on empty_table:
  document("Table {name} is empty")
  exclude_from_analysis()
  continue()  // don't fail the report

// VERY LARGE RESULT SETS (>1000 rows)
on large_result:
  aggregate(group_by_relevant_dimension)
  highlight(top_10, bottom_10)
  link_to_appendix(full_data)
// NEVER: dump raw data
```
