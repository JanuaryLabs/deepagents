# Trend Analysis Pattern

## Concept

Trend analysis examines how metrics evolve over time, revealing growth trajectories, seasonal patterns, and anomalies. By aggregating data into time buckets and computing period-over-period changes, you can distinguish genuine trends from noise and spot inflection points early.

The goal is not just to see *what* happened, but to understand *how* things are changing. A flat line at 1000 users/day tells a different story than oscillating between 800 and 1200—even if the average is identical.

## SQL Template

```sql
-- Trend Analysis Template
-- Replace placeholders: {{event_table}}, {{metric_column}}, {{time_grain}}, {{date_column}}

WITH period_metrics AS (
  SELECT
    DATE_TRUNC('{{time_grain}}', {{date_column}}) AS period,
    COUNT(*) AS metric_value,
    SUM({{metric_column}}) AS metric_sum
  FROM {{event_table}}
  GROUP BY 1
),
with_comparisons AS (
  SELECT
    period,
    metric_value,
    LAG(metric_value, 1) OVER (ORDER BY period) AS previous_period,
    LAG(metric_value, 52) OVER (ORDER BY period) AS same_period_last_year,
    AVG(metric_value) OVER (
      ORDER BY period ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS moving_avg_7
  FROM period_metrics
)
SELECT
  period,
  metric_value,
  previous_period,
  ROUND(100.0 * (metric_value - previous_period) / NULLIF(previous_period, 0), 1) AS pct_change,
  ROUND(100.0 * (metric_value - same_period_last_year) / NULLIF(same_period_last_year, 0), 1) AS yoy_change,
  ROUND(moving_avg_7, 1) AS moving_avg_7
FROM with_comparisons
ORDER BY period
```

## Variations

### Moving Average Smoothing
Reduce noise with configurable window sizes:
```sql
AVG(metric_value) OVER (ORDER BY period ROWS BETWEEN {{window_size}} PRECEDING AND CURRENT ROW)
```

### Year-over-Year Comparison
Account for seasonality by comparing to the same period last year:
```sql
LAG(metric_value, 52) OVER (ORDER BY period) -- for weekly data
LAG(metric_value, 12) OVER (ORDER BY period) -- for monthly data
```

### Seasonality Detection
Calculate deviation from expected seasonal pattern:
```sql
metric_value - AVG(metric_value) OVER (PARTITION BY EXTRACT(month FROM period))
```

### Anomaly Flagging
Identify outliers beyond N standard deviations:
```sql
CASE WHEN ABS(metric_value - moving_avg) > 2 * STDDEV(...) THEN 'anomaly' END
```

## When to Use

- Monitoring key business metrics over time
- Detecting growth acceleration or deceleration
- Identifying seasonal patterns for forecasting
- Spotting anomalies that require investigation

## When Not to Use

- Very short time windows with insufficient data points
- Highly irregular events that don't follow patterns
- When absolute values matter more than change rates

## See Also

Full worked example: [../../assets/examples/weekly-growth-trend.md](../../assets/examples/weekly-growth-trend.md)
