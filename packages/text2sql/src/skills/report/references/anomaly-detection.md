# Anomaly Detection Guidelines

How to identify what's worth investigating - using LLM judgment, not rigid thresholds.

## What Makes Data "Interesting"?

```
interesting_signals = {
  unexpected_values:    "Numbers that seem wrong or surprising",
  pattern_breaks:       "Something changed from the usual pattern",
  extremes:             "Highest, lowest, fastest growing",
  data_quality:         "Missing data, nulls, impossible values",
  correlations:         "Things that move together unexpectedly"
}
```

## Questions to Ask the Data

```
questions.extremes = ["What's the biggest/smallest?", "What's the fastest growing?"]
questions.changes = ["What changed the most?", "What should have changed but didn't?"]
questions.quality = ["What's missing or null?", "What has impossible values?"]
questions.relationships = ["What correlates unexpectedly?"]
```

## LLM Judgment Approach

```
// NO HARD THRESHOLDS
avoid = {
  fixed_rules:     "flag if change > 20%",
  arbitrary_cuts:  "top 5 only"
}

// INSTEAD: CONTEXTUAL JUDGMENT
approach = {
  business_context:   "Would a stakeholder care?",
  domain_knowledge:   "Is this normal for this data type?",
  pattern_recognition: "Does this break a pattern?"
}

is_anomaly = llm.evaluate({
  observation:    what_the_data_shows,
  expectation:    what_would_be_normal,
  impact:         does_it_matter
})
```

## Red Flags to Always Investigate

```
always_investigate.nulls = [
  "Nulls in critical fields (user_id, amount, date)",
  "Sudden increase in null rate"
]

always_investigate.impossible = [
  "Negative values where only positive expected",
  "Future dates in historical data",
  "Values outside valid range"
]

always_investigate.patterns = [
  "Sudden zeros after consistent values",
  "Cliff drops or spikes"
]
```

## Comparative Benchmarks

```
benchmarks = {
  prior_period:     "vs last week/month/quarter",
  same_period_prior: "vs same month last year",
  rolling_average:  "vs 30-day moving average",
  target:           "vs goal or forecast"
}
```

## Documentation Pattern

```
anomaly.document = {
  what:       "Revenue dropped 30% in March",
  where:      "Product X, West region only",
  when:       "Started March 15",
  magnitude:  "From $200K to $140K weekly",
  status:     "Investigating" | "Explained" | "Unknown"
}
```
