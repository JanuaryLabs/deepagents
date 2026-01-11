# Cohort Analysis Pattern

## Concept

Cohort analysis groups users by a shared characteristic—typically their acquisition or signup date—then tracks their behavior over subsequent time periods. This reveals how different "vintages" of users behave, enabling you to measure retention, lifetime value, and the impact of product changes on specific user groups.

The power of cohort analysis lies in comparing apples to apples: rather than mixing new and established users in aggregate metrics, you isolate each group and observe their trajectory independently.

## SQL Template

```sql
-- Cohort Analysis Template
-- Replace placeholders: {{user_table}}, {{event_table}}, {{cohort_dimension}}, {{time_grain}}

WITH cohort_assignment AS (
  SELECT
    user_id,
    DATE_TRUNC('{{time_grain}}', {{cohort_dimension}}) AS cohort_period
  FROM {{user_table}}
),
user_activity AS (
  SELECT
    user_id,
    DATE_TRUNC('{{time_grain}}', activity_date) AS activity_period
  FROM {{event_table}}
)
SELECT
  c.cohort_period,
  DATEDIFF('{{time_grain}}', c.cohort_period, a.activity_period) AS periods_since_join,
  COUNT(DISTINCT a.user_id) AS active_users,
  COUNT(DISTINCT c.user_id) AS cohort_size,
  ROUND(100.0 * COUNT(DISTINCT a.user_id) / COUNT(DISTINCT c.user_id), 1) AS retention_pct
FROM cohort_assignment c
LEFT JOIN user_activity a ON c.user_id = a.user_id
GROUP BY 1, 2
ORDER BY 1, 2
```

## Variations

### Revenue Cohort
Track cumulative revenue per cohort to understand lifetime value curves:
```sql
SUM(revenue) AS cumulative_revenue,
SUM(revenue) / COUNT(DISTINCT user_id) AS revenue_per_user
```

### Feature Adoption Cohort
Measure how quickly different cohorts adopt a specific feature:
```sql
WHERE event_type = '{{feature_event}}'
```

### Behavioral Cohort
Group by first action taken rather than signup date—useful for product-led growth.

## When to Use

- Measuring retention and churn over time
- Understanding user lifetime value by acquisition period
- Evaluating impact of product changes on new vs. existing users
- Comparing acquisition channel quality

## When Not to Use

- Small sample sizes where cohorts lack statistical significance
- When time-based grouping obscures the real segmentation (consider behavioral cohorts)
- For real-time dashboards requiring instant updates

## See Also

Full worked example: [../../assets/examples/retention-cohort.md](../../assets/examples/retention-cohort.md)
