# Exploration Workflow

Ad-hoc discovery - start broad, let findings guide the journey.

## When to Use

```
use_exploration_when = {
  no_specific_question:  "what's interesting in the data?",
  general_curiosity:     "give me a report on this database",
  first_time_analysis:   "I've never looked at this data before"
}
// ANTI-PATTERN: focused_questions → use focused.md instead
```

## The Exploration Mindset

```
exploration_mode = {
  breadth_first:    true,   // survey everything before diving deep
  follow_anomalies: true,   // weird data is interesting data
  no_agenda:        true    // let findings guide you
}
```

## Phase 1: Schema Reconnaissance

```
reconnaissance = {
  list_tables:    "SELECT table_name FROM information_schema",
  count_rows:     "SELECT COUNT(*) FROM each_table",
  find_relations: "inspect foreign keys, naming patterns"
}

schema_model = {
  core_entities:   [],   // users, orders, products
  junction_tables: [],   // user_roles, order_items
  lookup_tables:   []    // status_codes, categories
}
```

## Phase 2: Baseline Metrics

```
for each core_entity:
  baseline = {
    total_count:       "how many records?",
    date_range:        "earliest to latest timestamp",
    key_distributions: "status breakdown, category split"
  }
```

## Phase 3: Anomaly Hunting

```
anomaly_checks = {
  outliers:      "values far from the mean",
  nulls:         "unexpected missing data",
  time_patterns: "spikes? gaps? seasonality?",
  orphans:       "broken foreign key relationships?"
}
// RULE: anomalies are breadcrumbs → follow them
```

## Phase 4: Deep-Dive on Findings

```
deep_dive(finding) = {
  quantify:   "how big is this?",
  segment:    "who/what is affected?",
  timeline:   "when did this start?",
  correlate:  "what else changed?"
}
```

## Phase 5: Synthesis

```
synthesis = {
  themes:        group_findings_by_topic,
  relationships: find_connections_between_discoveries,
  importance:    rank_by_business_impact
}
```

## Phase 6: Executive Summary

```
summary_format = {
  headline:     one_sentence_overview,
  key_findings: [{finding, impact, action}],
  data_quality: known_issues_and_caveats,
  next_steps:   recommended_deep_dives
}
```

## Example Flow

```
user: "What's interesting in this e-commerce database?"

flow = [
  // Phase 1-2: Reconnaissance + Baselines
  → "50k users, 200k orders, 5k products"
  → "Orders span 2022-2024, avg value $85"

  // Phase 3: Anomaly hunting
  → "15% of users have never ordered"
  → "Reviews dropped 60% in last 3 months"

  // Phase 4: Deep-dive
  → "Never-ordered: 80% signed up last month"
  → "Review drop correlates with UI change"

  // Phase 5-6: Synthesis + Summary
  → "Key findings:
     1. Strong seasonal pattern (5x November)
     2. Recent signups not converting
     3. Review submission broken since Oct"
]
```
