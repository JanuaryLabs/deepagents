# Trend Analysis Workflow

Time-series analysis - understand how things change over time.

## When to Use

```
trigger_phrases = ["how is X trending?", "growth over time", "any seasonality?"]

trend_types = {
  growth_tracking:    "is metric improving?",
  pattern_detection:  "weekly/monthly cycles?",
  anomaly_finding:    "unusual spikes/drops?",
  inflection_points:  "when did trend change?"
}
```

## The Trend Mindset

```
trend_analysis = {
  x_axis:    always_time,
  y_axis:    metric_of_interest,
  goal:      understand_trajectory
}

key_questions = ["What direction?", "How fast?", "Predictable patterns?"]
```

## Phase 1: Identify Time Dimension

```
time_grains = {
  daily:      "short-term, fast cycles",
  weekly:     "operational patterns",
  monthly:    "business reporting",
  quarterly:  "strategic view"
}
// Finer grain = more noise, coarser = smoother
```

## Phase 2: Establish Historical Context

```
lookback = {minimum: 2x_pattern_cycle, typical: 12_months}

annotations = {"2024-03": "pricing_change", "2024-11": "black_friday"}
```

## Phase 3: Calculate Period-over-Period

```
comparisons = {
  MoM:  month_over_month,    // momentum
  QoQ:  quarter_over_quarter,
  YoY:  year_over_year       // removes seasonality
}
// Seasonal business: prefer YoY | Fast moving: prefer MoM
```

## Phase 4: Identify Patterns

```
patterns = {
  trend:        "persistent direction",
  seasonality:  "predictable recurring",
  noise:        "random variation"
}

trend_signals = {upward, downward, accelerating, decelerating}
anomaly = value > mean + 2*stddev
```

## Phase 5: Correlate with Causes

```
causation = {internal: "what did WE do?", external: "what happened in MARKET?"}

internal = [launches, pricing, campaigns]
external = [competitors, market, seasonal]
```

## Phase 6: Forecast Implications

```
scenarios = {optimistic, base, pessimistic}

implications = {
  resources:  "need more capacity?",
  financial:  "what about targets?",
  strategic:  "change approach?"
}
```

---

## Example Flow

```
user_asks("How is MRR trending?")

grain = "monthly", periods = 24
growth = {mom: +3.2%, yoy: +38%}
patterns = {trend: "upward", seasonality: "Q4 stronger"}
drivers = {enterprise: "+$50k", pricing: "+12%"}

report = {
  headline:  "MRR up 38% YoY, accelerating",
  insight:   "Enterprise driving outperformance",
  watch:     "churn rate, enterprise conversion"
}
```
