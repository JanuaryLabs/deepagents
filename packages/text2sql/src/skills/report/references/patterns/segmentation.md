# Segmentation Analysis Pattern

## Concept

Segmentation breaks data into meaningful groups to reveal patterns hidden in aggregate
metrics. An "average customer" often doesn't exist—your data contains distinct populations
with different behaviors, needs, and values. Good segmentation surfaces these differences.

The best segments are **actionable**: you can do something different for each group.
Segments that don't lead to different strategies are academically interesting but
practically useless. Before building segments, ask: "What will we do differently for
each group?"

## SQL Templates

```sql
-- Value-based Segmentation (RFM-inspired)
SELECT
  CASE
    WHEN total_spend >= {{high_threshold}} THEN 'high_value'
    WHEN total_spend >= {{medium_threshold}} THEN 'medium_value'
    ELSE 'low_value'
  END AS value_segment,
  COUNT(*) AS customer_count,
  ROUND(AVG(total_spend), 2) AS avg_spend,
  ROUND(AVG(order_count), 2) AS avg_orders,
  ROUND(AVG(days_since_last_order), 1) AS avg_recency_days
FROM {{customer_summary_table}}
GROUP BY 1
ORDER BY avg_spend DESC;

-- Behavioral / Lifecycle Segmentation
SELECT
  CASE
    WHEN last_activity < CURRENT_DATE - INTERVAL '{{churn_days}} days' THEN 'churned'
    WHEN first_activity > CURRENT_DATE - INTERVAL '{{new_days}} days' THEN 'new'
    WHEN order_count >= {{power_user_orders}} THEN 'power_user'
    ELSE 'active'
  END AS lifecycle_stage,
  COUNT(*) AS user_count,
  ROUND(AVG(lifetime_value), 2) AS avg_ltv
FROM {{users_table}}
GROUP BY 1;

-- Demographic Segmentation with Behavioral Overlay
SELECT
  {{demographic_field}},
  COUNT(*) AS segment_size,
  ROUND(AVG({{metric}}), 2) AS avg_metric,
  ROUND(STDDEV({{metric}}), 2) AS stddev_metric,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY {{metric}}) AS median_metric
FROM {{table}}
GROUP BY 1
HAVING COUNT(*) >= {{min_segment_size}}
ORDER BY avg_metric DESC;
```

## When to Use

- **Personalization**: Tailoring experiences, offers, or communications by group
- **Resource allocation**: Focusing effort on highest-potential segments
- **Churn prevention**: Identifying at-risk groups for intervention
- **Product development**: Understanding distinct user needs

## When NOT to Use

- **No differentiated action**: If every segment gets the same treatment, why segment?
- **Insufficient data**: Small segments produce unreliable statistics
- **Unstable membership**: If customers constantly shift segments, targeting becomes noise
- **Over-segmentation**: Too many segments dilutes focus and statistical power

## Common Pitfalls

1. **Vanity segments**: Creating segments that look clever but don't drive action.
   Always tie segments to specific business decisions.

2. **Static thinking**: Customers move between segments over time. Build processes
   to track migration and understand the journey, not just current state.

3. **Ignoring segment size**: A "whale" segment of 3 customers isn't actionable.
   Ensure segments are large enough to matter and analyze reliably.

4. **Threshold arbitrariness**: Why is "high value" at $1000 and not $950? Document
   rationale for cutoffs and test sensitivity to different thresholds.

5. **Missing the middle**: Focus often goes to extremes (best and worst customers).
   The "movable middle" segments often have the highest ROI for intervention.

6. **Demographic assumptions**: Behavioral segments often outperform demographics.
   What customers *do* predicts better than who they *are*.
