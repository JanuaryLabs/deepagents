# Distribution Analysis Pattern

Distribution analysis reveals the full shape of your data—not just central tendencies like averages, but how values spread across the range. This matters because averages lie. A company with average revenue of $100K might have 90% of customers paying $10K and 10% paying $910K. Understanding distribution exposes this reality.

The key insight: medians resist outliers, percentiles show spread, and histograms reveal modality. When someone asks "what's typical?", the answer often requires showing the distribution, not computing a single number.

## SQL Template

```sql
-- Histogram Buckets
SELECT
  FLOOR(value / 10) * 10 AS bucket,
  COUNT(*) AS frequency,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS percentage
FROM data
GROUP BY 1
ORDER BY 1

-- Percentile Analysis
SELECT
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY value) AS p25,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY value) AS p50,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value) AS p75,
  PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY value) AS p90,
  PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY value) AS p99
FROM data
```

## Distribution Techniques

### Dynamic Histogram Buckets

```sql
WITH stats AS (SELECT MIN(value) AS min_val, MAX(value) AS max_val FROM data)
SELECT FLOOR((value - min_val) / ((max_val - min_val) / 10)) AS bucket, COUNT(*) AS frequency
FROM data, stats GROUP BY 1 ORDER BY 1
```

### Outlier Detection (IQR Method)

```sql
WITH percentiles AS (
  SELECT
    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY value) AS q1,
    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value) AS q3
  FROM data
)
SELECT *
FROM data, percentiles
WHERE value < q1 - 1.5 * (q3 - q1)
   OR value > q3 + 1.5 * (q3 - q1)
```

### Skewness Indicators

```sql
SELECT
  AVG(value) AS mean,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value) AS median
FROM data
-- Right-skewed if mean > median * 1.1
```

## When to Use

- Understanding customer value distribution
- Analyzing response times or latencies (often right-skewed)
- Detecting anomalies or data quality issues
- Setting thresholds or SLAs based on percentiles

## When NOT to Use

- Binary or categorical data (use frequency counts instead)
- Very small sample sizes (percentiles become unreliable)

## Common Pitfalls

1. **Trusting Averages Alone**: Revenue and latencies are rarely normally distributed.
2. **Fixed Bucket Sizes**: Scale buckets to your data range.
3. **Ignoring the Tails**: P99 latency might be 10x the median.
4. **Bimodal Blindness**: Two customer segments produce two peaks—averaging describes neither.
