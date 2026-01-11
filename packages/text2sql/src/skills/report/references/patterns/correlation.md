# Correlation Analysis Pattern

## Concept

Correlation analysis reveals relationships between metrics: when X changes, does Y change
too? This pattern helps identify potential connections in your data, but remember the
critical caveat: **correlation does not imply causation**. Use correlation for hypothesis
generation and exploratory analysis, not as proof of cause-and-effect relationships.

Strong correlations suggest areas worth investigating further. A high correlation between
marketing spend and sales doesn't prove marketing causes sales—both might be driven by
seasonality, or successful products might get more marketing budget.

## SQL Templates

```sql
-- Co-movement Analysis: How does metric_b behave across metric_a ranges?
SELECT
  metric_a_bucket,
  AVG(metric_b) AS avg_metric_b,
  STDDEV(metric_b) AS stddev_metric_b,
  COUNT(*) AS sample_size
FROM (
  SELECT
    NTILE(10) OVER (ORDER BY metric_a) AS metric_a_bucket,
    metric_b
  FROM {{table}}
  WHERE metric_a IS NOT NULL AND metric_b IS NOT NULL
) bucketed
GROUP BY 1
ORDER BY 1;

-- Cross-tabulation / Contingency Table
SELECT
  {{category_a}} AS category_a,
  {{category_b}} AS category_b,
  COUNT(*) AS frequency,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS pct_of_total
FROM {{table}}
GROUP BY 1, 2
ORDER BY 1, 2;

-- Lead/Lag Analysis: Does metric_a predict metric_b in future periods?
SELECT
  period,
  metric_a,
  metric_b,
  LAG(metric_a, 1) OVER (ORDER BY period) AS metric_a_prev_period,
  LAG(metric_a, 2) OVER (ORDER BY period) AS metric_a_2_periods_ago
FROM {{table}}
ORDER BY period;
```

## When to Use

- **Exploratory analysis**: Finding unexpected relationships in data
- **Hypothesis generation**: Identifying patterns worth deeper investigation
- **Feature discovery**: Finding predictive signals for modeling
- **Anomaly detection**: Monitoring metric pairs that should move together

## When NOT to Use

- **Proving causation**: Correlation alone never proves X causes Y
- **Small sample sizes**: Spurious correlations appear frequently with limited data
- **Non-linear relationships**: Standard correlation misses U-shaped or threshold effects
- **Time series without stationarity**: Trending data produces misleading correlations

## Common Pitfalls

1. **Simpson's Paradox**: A correlation can reverse when you segment data. Always check
   if the relationship holds within meaningful subgroups.

2. **Confounding variables**: Two metrics may correlate because both are driven by a
   third factor. Ice cream sales and drowning deaths correlate—both increase in summer.

3. **Outlier sensitivity**: A few extreme values can create or mask correlations.
   Always visualize the data and consider robust measures.

4. **Multiple testing**: When checking many metric pairs, some will correlate by chance.
   Be skeptical of correlations discovered through exhaustive searching.

5. **Lag structure**: Relationships may not be instantaneous. Marketing spend today
   might correlate with sales next month, not this month.
