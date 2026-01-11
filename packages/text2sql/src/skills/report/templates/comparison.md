# Comparison Workflow

A vs B analysis - understand differences and their causes.

## When to Use

```
trigger_phrases = ["how does X compare to Y?", "what changed?", "A vs B"]

comparison_types = {
  temporal:     "Q1 vs Q2, this year vs last year",
  segmental:    "enterprise vs SMB, new vs returning",
  categorical:  "product A vs B, region X vs Y"
}
```

## The Comparison Mindset

```
// FAIR COMPARISONS REQUIRE CONTROL
comparison_validity = {
  same_timeframe:     true,
  same_definitions:   true,   // metrics calculated same way
  same_population:    true
}

// AVOID THESE TRAPS
comparison_traps = [apples_to_oranges, cherry_picking, survivorship_bias]
```

## Phase 1: Define Comparison Dimensions

```
comparison_setup = {
  entity_a:      identify(first_thing),
  entity_b:      identify(second_thing),
  metrics:       list(relevant_measurements)
}

if unclear(scope): ask("What aspects to compare?")
```

## Phase 2: Establish Common Metrics

```
metric_alignment = {
  definition:    same_calculation_method,
  timeframe:     align_periods,
  scope:         match_populations
}

normalization = {per_capita, indexed, percentage}
```

## Phase 3: Calculate Deltas

```
absolute_delta = entity_b - entity_a
pct_change = (entity_b - entity_a) / entity_a * 100

// Small numbers: prefer absolute ("3 vs 5" not "67%")
// Large numbers: prefer percentage
// Rates: prefer points ("+3pp")
```

## Phase 4: Identify Significant Differences

```
significance = {
  statistical:    is_difference_real_or_noise,
  practical:      does_difference_matter,
  actionable:     finding_suggests_response
}

noise_indicators = [small_sample, high_variance, one_time_anomaly]
```

## Phase 5: Investigate Root Causes

```
root_cause = {
  decompose:     break_into_components,
  segment:       check_across_dimensions,
  correlate:     look_for_drivers
}

typical_drivers = [seasonality, campaigns, pricing, launches]
```

## Phase 6: Synthesis with Recommendations

```
synthesis = {
  headline:       "X outperformed Y by Z%",
  key_deltas:     top_3_differences,
  drivers:        why_differences_exist,
  actions:        [investigate, replicate, correct]
}
```

---

## Example Flow

```
user_asks("How did Q4 compare to Q3?")

entities = {a: "Q3", b: "Q4"}
deltas = {revenue: +18%, orders: +12%}
drivers = {holiday: 40%, promo: 35%}

report = {
  headline: "Q4 revenue up 18% vs Q3",
  insight:  "Holiday + promo drove growth",
  action:   "Isolate promo impact for planning"
}
```
