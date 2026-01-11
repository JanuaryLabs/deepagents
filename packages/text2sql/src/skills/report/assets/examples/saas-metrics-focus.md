# Churn Analysis Report

Generated: 2024-01-15
Workflow: Focused Analysis
Question: Why did churn increase in Q4 2023?

---

## Executive Answer

Churn increased from 2.1% to 3.8% primarily due to the October 1st pricing changes affecting the SMB segment. Enterprise churn remained stable at 0.9%, while SMB churn nearly doubled from 4.2% to 8.1%.

**Confidence:** High (clear correlation between pricing change and churn timing, supported by exit survey data)

---

## Question Decomposition

To answer "Why did churn increase in Q4 2023?", we investigated:

| Sub-Question | Purpose |
|--------------|---------|
| How much did churn actually increase? | Quantify the magnitude |
| When did the increase start? | Identify timing |
| Which customer segments were affected? | Isolate the population |
| What correlated with churned customers? | Find root cause |
| Are there product/usage signals? | Rule out alternatives |

---

## Core Findings

### Overall Churn Trend

Monthly churn rate tracked over 6 months:

| Month | Active Customers | Churned | Churn Rate | Change |
|-------|------------------|---------|------------|--------|
| Jul 2023 | 8,234 | 165 | 2.0% | - |
| Aug 2023 | 8,412 | 176 | 2.1% | +0.1pp |
| Sep 2023 | 8,589 | 180 | 2.1% | - |
| Oct 2023 | 8,756 | 254 | 2.9% | +0.8pp |
| Nov 2023 | 8,821 | 327 | 3.7% | +0.8pp |
| Dec 2023 | 8,902 | 338 | 3.8% | +0.1pp |

**Visual:**
```
Jul ████ 2.0%
Aug ████ 2.1%
Sep ████ 2.1%
Oct ██████ 2.9% ← Pricing change (Oct 1)
Nov ████████ 3.7%
Dec ████████ 3.8%
```

**Key Observation:** Churn began increasing in October, coinciding exactly with the October 1st pricing change rollout.

---

### Segment Breakdown

Churn rate by customer segment reveals SMB as primary driver:

| Segment | Q3 Churn | Q4 Churn | Delta | % of Total Increase |
|---------|----------|----------|-------|---------------------|
| Enterprise (>$50K ARR) | 0.8% | 0.9% | +0.1pp | 3% |
| Mid-Market ($10K-$50K) | 1.9% | 2.4% | +0.5pp | 8% |
| SMB (<$10K ARR) | 4.2% | 8.1% | +3.9pp | 89% |
| **Overall** | **2.1%** | **3.8%** | **+1.7pp** | **100%** |

**Key Insight:** SMB segment drove 89% of the churn increase. Enterprise remained essentially flat.

**SMB Deep-Dive:**

| SMB Tier | Customers | Q3 Churn | Q4 Churn | MRR Impact |
|----------|-----------|----------|----------|------------|
| Starter ($29/mo) | 3,456 | 5.1% | 11.2% | -$18,920 |
| Growth ($79/mo) | 2,123 | 3.8% | 6.4% | -$10,854 |
| Professional ($149/mo) | 1,234 | 2.9% | 4.1% | -$6,812 |

**Observation:** Starter tier (lowest-priced SMB plan) saw the largest relative increase: from 5.1% to 11.2% (+6.1pp).

---

### Timeline Analysis

Daily churn tracking pinpoints the inflection:

| Week | Dates | Churns | Avg Daily | Notable Events |
|------|-------|--------|-----------|----------------|
| W39 | Sep 25-Oct 1 | 42 | 6.0 | - |
| W40 | Oct 2-8 | 58 | 8.3 | Pricing emails sent Oct 1 |
| W41 | Oct 9-15 | 71 | 10.1 | Price increase effective |
| W42 | Oct 16-22 | 84 | 12.0 | - |
| W43 | Oct 23-29 | 89 | 12.7 | - |

**Key Observation:** Churn jumped 38% in the week following pricing emails, and continued climbing through October.

---

### Root Cause Investigation

#### Pricing Change Details

The October 1st pricing change increased SMB plan prices:

| Plan | Old Price | New Price | Increase |
|------|-----------|-----------|----------|
| Starter | $19/mo | $29/mo | +53% |
| Growth | $49/mo | $79/mo | +61% |
| Professional | $99/mo | $149/mo | +51% |

Enterprise pricing remained unchanged (custom contracts).

#### Exit Survey Analysis

Of 919 Q4 churns, 634 (69%) completed exit surveys:

| Reason | Count | % of Responses |
|--------|-------|----------------|
| "Price too high" | 425 | 67% |
| "Found cheaper alternative" | 87 | 14% |
| "No longer need the product" | 56 | 9% |
| "Missing features" | 34 | 5% |
| "Other" | 32 | 5% |

**Key Insight:** 67% of respondents cited price as primary reason. Among SMB churns specifically, this rises to 78%.

#### Sample Verbatim Feedback

> "Love the product but 61% increase is too much for our budget"

> "Switching to [Competitor X] - same features, half the price"

> "Would stay at the old price point. New pricing doesn't fit our startup budget."

---

### Alternative Hypotheses Ruled Out

| Hypothesis | Investigation | Finding |
|------------|---------------|---------|
| Product issues | Checked support tickets, error rates | No increase in Q4 |
| Competitor launch | Market research | No new entrants in Q4 |
| Feature removal | Product changelog | No features removed |
| Onboarding problems | New customer churn | Actually improved in Q4 |
| Seasonal patterns | YoY comparison | No Q4 spike in prior years |

**Conclusion:** Pricing is the clear and isolated cause.

---

### Churned Customer Profile

Characteristics of Q4 churned SMB customers:

| Attribute | Churned SMBs | Retained SMBs | Delta |
|-----------|--------------|---------------|-------|
| Avg tenure | 8.2 months | 14.6 months | -6.4 mo |
| Avg MRR | $47 | $89 | -$42 |
| Feature adoption | 34% | 67% | -33pp |
| Support tickets | 1.2 avg | 2.8 avg | -1.6 |

**Insight:** Churned customers were newer, lower-paying, and less engaged. They were price-sensitive users who hadn't deeply adopted the product.

---

## Financial Impact

| Metric | Value |
|--------|-------|
| Q4 Churned MRR | $78,450 |
| Annualized Lost Revenue | $941,400 |
| New MRR from Price Increase | $156,780 |
| Net Annual Impact | -$784,620 |

**Note:** Price increase generated $156K additional MRR from retained customers, but churn created $941K annualized loss. Net negative of $785K.

---

## Cohort Comparison

Retention curves for customers acquired before vs after pricing change:

| Month | Pre-Change Cohort | Post-Change Cohort |
|-------|-------------------|-------------------|
| M1 | 95% | 94% |
| M2 | 91% | 88% |
| M3 | 87% | 82% |
| M4 | 84% | 76% |

**Observation:** Post-change cohort retaining 8pp worse at month 4. Suggests pricing is filtering for wrong customer profile.

---

## Confidence Assessment

| Factor | Assessment |
|--------|------------|
| Data completeness | Complete - all churn tracked |
| Pattern clarity | Clear - timing exactly matches pricing |
| Segment isolation | Clean - SMB only, Enterprise stable |
| Exit survey support | Strong - 67% cite price |
| Alternative explanations | Ruled out - no product/market issues |
| **Overall Confidence** | **High** |

---

## Key Takeaways

**Top Finding:** October 1st pricing change caused SMB churn spike. The 40-60% price increases hit price-sensitive smaller customers hardest, with Starter tier churn more than doubling.

**Concern:** SMB segment may not be viable at new price points. Unit economics need review - are these the customers we want to retain?

**Opportunity:** Consider SMB-specific pricing tier or grandfather existing customers to stem ongoing churn. Win-back campaign could recover recently churned at old pricing.

**Next Steps:**
1. Review SMB unit economics at old vs new pricing (are we profitable on Starter?)
2. Model grandfather pricing for existing SMB customers
3. Launch win-back campaign for Q4 churns with limited-time old pricing
4. A/B test intermediate pricing tier ($39 Starter, $59 Growth) for new SMB signups
5. Implement churn prediction model to intervene before cancellation

---

## Appendix: Queries Used

```sql
-- Monthly Churn Rate by Segment
SELECT
  DATE_TRUNC('month', churned_at) as month,
  segment,
  COUNT(DISTINCT customer_id) as churned,
  COUNT(DISTINCT customer_id)::float /
    LAG(COUNT(DISTINCT customer_id)) OVER (PARTITION BY segment ORDER BY month) as churn_rate
FROM subscriptions
WHERE churned_at >= '2023-07-01'
GROUP BY 1, 2;

-- Exit Survey Reasons
SELECT
  reason_category,
  COUNT(*) as responses,
  COUNT(*)::float / SUM(COUNT(*)) OVER () as pct
FROM exit_surveys
WHERE survey_date >= '2023-10-01'
GROUP BY 1
ORDER BY 2 DESC;

-- Churned Customer Profile
SELECT
  AVG(EXTRACT(MONTH FROM AGE(churned_at, created_at))) as avg_tenure_months,
  AVG(mrr) as avg_mrr,
  AVG(features_used::float / total_features) as feature_adoption
FROM subscriptions s
JOIN customers c ON s.customer_id = c.id
WHERE churned_at BETWEEN '2023-10-01' AND '2023-12-31'
  AND segment = 'SMB';
```

---

*Report generated using focused analysis workflow. Question decomposition, evidence gathering, and alternative hypothesis testing completed. Confidence level: High.*
