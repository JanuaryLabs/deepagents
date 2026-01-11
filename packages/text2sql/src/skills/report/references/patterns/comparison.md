# Comparison Analysis Pattern

Comparison analysis evaluates two or more segments, time periods, or groups side-by-side to identify meaningful differences. The fundamental challenge is ensuring fair comparison—comparing apples to apples rather than apples to oranges. Before drawing conclusions, verify that compared groups share similar baseline characteristics and sample sizes are adequate.

Not all differences are meaningful. A 2% difference between segments might be noise, while a 20% difference likely signals something real. Consider statistical significance and whether confounding variables explain the gap.

## SQL Template

```sql
-- Comparison Analysis Template
SELECT
  segment,
  COUNT(*) AS total_count,
  AVG(value) AS avg_value,
  SUM(value) AS total_value,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) AS median_value
FROM data
WHERE period IN ('A', 'B')
GROUP BY segment
```

## Common Comparison Types

### Period-over-Period Comparison

```sql
SELECT
  DATE_TRUNC('month', created_at) AS period,
  COUNT(*) AS transactions,
  SUM(amount) AS revenue,
  AVG(amount) AS avg_order_value
FROM orders
WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '2 months'
GROUP BY 1
ORDER BY 1
```

### Segment Comparison

```sql
SELECT
  customer_tier,
  COUNT(DISTINCT customer_id) AS customers,
  SUM(revenue) AS total_revenue,
  AVG(revenue) AS avg_revenue_per_customer
FROM customer_revenue
GROUP BY customer_tier
```

### A/B Test Analysis

```sql
SELECT
  variant,
  COUNT(*) AS sample_size,
  AVG(converted::int) AS conversion_rate,
  STDDEV(converted::int) / SQRT(COUNT(*)) AS standard_error
FROM experiment_users
WHERE experiment_id = 'exp_123'
GROUP BY variant
```

## When to Use

- Evaluating performance changes over time
- Comparing customer segments or cohorts
- Analyzing A/B test results
- Benchmarking against competitors or industry standards

## When NOT to Use

- Sample sizes are vastly different (100 vs 10,000)
- Time periods have different seasonality (December vs July)
- Segments have fundamentally different characteristics

## Common Pitfalls

1. **Simpson's Paradox**: Aggregate trends can reverse when segmented. Always check subgroups.
2. **Survivorship Bias**: Comparing only customers who stayed ignores churned ones.
3. **Cherry-picking Periods**: Use consistent, pre-defined comparison periods.
4. **Ignoring Confidence Intervals**: Small samples produce unreliable averages.
5. **Confounding Variables**: Higher revenue may reflect tenure, not segment characteristics.
