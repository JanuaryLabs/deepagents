# Funnel Analysis Pattern

## Concept

Funnel analysis tracks users through a sequence of steps, measuring how many complete each stage and where they drop off. Users enter at the top of the funnel, and at each subsequent stage, some portion exits. This reveals conversion bottlenecks and optimization opportunities.

The key insight from funnel analysis is not just the overall conversion rate, but *where* users struggle. A 10% overall conversion might hide a 90% drop at one specific step—fixing that step yields massive gains.

## SQL Template

```sql
-- Funnel Analysis Template
-- Replace placeholders: {{event_table}}, {{stage_conditions}}, {{time_window}}

WITH user_stages AS (
  SELECT
    user_id,
    MAX(CASE WHEN {{stage_1_condition}} THEN 1 ELSE 0 END) AS reached_stage_1,
    MAX(CASE WHEN {{stage_2_condition}} THEN 1 ELSE 0 END) AS reached_stage_2,
    MAX(CASE WHEN {{stage_3_condition}} THEN 1 ELSE 0 END) AS reached_stage_3,
    MAX(CASE WHEN {{stage_4_condition}} THEN 1 ELSE 0 END) AS reached_stage_4
  FROM {{event_table}}
  WHERE created_at >= CURRENT_DATE - INTERVAL '{{time_window}}'
  GROUP BY user_id
),
funnel_counts AS (
  SELECT
    SUM(reached_stage_1) AS stage_1_count,
    SUM(reached_stage_2) AS stage_2_count,
    SUM(reached_stage_3) AS stage_3_count,
    SUM(reached_stage_4) AS stage_4_count
  FROM user_stages
)
SELECT
  stage_1_count AS visited,
  stage_2_count AS signed_up,
  stage_3_count AS activated,
  stage_4_count AS converted,
  ROUND(100.0 * stage_2_count / NULLIF(stage_1_count, 0), 1) AS visit_to_signup_pct,
  ROUND(100.0 * stage_3_count / NULLIF(stage_2_count, 0), 1) AS signup_to_activation_pct,
  ROUND(100.0 * stage_4_count / NULLIF(stage_3_count, 0), 1) AS activation_to_conversion_pct,
  ROUND(100.0 * stage_4_count / NULLIF(stage_1_count, 0), 1) AS overall_conversion_pct
FROM funnel_counts
```

## Variations

### Time-Bounded Funnel
Require users to complete stages within a specific window:
```sql
WHERE stage_2_timestamp <= stage_1_timestamp + INTERVAL '7 days'
```

### Branching Funnel
Track multiple paths (e.g., signup via email vs. OAuth):
```sql
CASE WHEN signup_method = 'email' THEN ... END AS email_path,
CASE WHEN signup_method = 'oauth' THEN ... END AS oauth_path
```

### Segmented Funnel
Break down by user attributes to find high-performing segments:
```sql
GROUP BY user_segment, acquisition_source
```

## When to Use

- Optimizing onboarding or checkout flows
- Identifying conversion bottlenecks
- A/B testing step-level improvements
- Comparing conversion across segments or channels

## When Not to Use

- Non-linear user journeys where order doesn't matter
- Exploratory products without clear conversion goals
- When stages overlap or users can skip steps

## See Also

Full worked example: [../../assets/examples/checkout-funnel.md](../../assets/examples/checkout-funnel.md)
