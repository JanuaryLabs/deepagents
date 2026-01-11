# E-Commerce Data Exploration Report

Generated: 2024-01-15
Workflow: Exploration (ad-hoc discovery)
Database: ecommerce_prod

---

## At a Glance

| Metric | Value |
|--------|-------|
| Core Tables | 5 (orders, customers, products, categories, order_items) |
| Date Range | 2022-01-01 to 2024-01-14 |
| Total Orders | 45,231 |
| Total Revenue | $3.2M |
| Unique Customers | 12,456 |
| Average Order Value | $70.75 |

---

## Schema Reconnaissance

### Entity Overview

```
customers (12,456 rows)
    └── orders (45,231 rows)
            └── order_items (127,843 rows)
                    └── products (2,341 rows)
                            └── categories (24 rows)
```

### Table Profiles

| Table | Rows | Date Range | Key Fields |
|-------|------|------------|------------|
| customers | 12,456 | 2022-01 to 2024-01 | id, email, created_at, segment |
| orders | 45,231 | 2022-01 to 2024-01 | id, customer_id, total, status, created_at |
| order_items | 127,843 | 2022-01 to 2024-01 | order_id, product_id, quantity, price |
| products | 2,341 | - | id, name, category_id, price, cost |
| categories | 24 | - | id, name, parent_id |

### Data Quality Notes

- 3.2% of orders missing `shipping_date` (digital products - expected)
- 147 customers have NULL email (guest checkouts)
- All foreign key relationships intact

---

## Key Findings

### Finding 1: December Revenue Spike

Monthly revenue shows strong seasonal pattern with December significantly outperforming:

| Month | Revenue | vs Prev Month | vs Prior Year |
|-------|---------|---------------|---------------|
| Oct 2023 | $245,120 | +8% | +12% |
| Nov 2023 | $312,450 | +27% | +19% |
| Dec 2023 | $489,230 | +57% | +23% |
| Jan 2024 | $198,340 | -59% | +5% |

**Visual:**
```
Oct 2023 ████████████████████████ $245K
Nov 2023 ███████████████████████████████ $312K (+27%)
Dec 2023 █████████████████████████████████████████████████ $489K (+57%)
Jan 2024 ███████████████████ $198K (-59%)
```

**Deep-Dive Investigation:**

Queried revenue by category during December spike:

| Category | Nov Revenue | Dec Revenue | Change | % of Spike |
|----------|-------------|-------------|--------|------------|
| Electronics | $98,400 | $236,100 | +140% | 78% |
| Clothing | $87,200 | $102,300 | +17% | 9% |
| Home & Garden | $62,100 | $78,400 | +26% | 9% |
| Books | $34,200 | $38,900 | +14% | 3% |
| Other | $30,550 | $33,530 | +10% | 2% |

**Insight:** Electronics drove 78% of the December increase. Top sellers were:
1. Wireless Headphones Pro ($89.99) - 2,847 units
2. Smart Watch Series 5 ($249.99) - 1,234 units
3. Bluetooth Speaker Max ($129.99) - 987 units

---

### Finding 2: Customer Concentration Risk

Revenue distribution analysis reveals concerning concentration:

| Customer Tier | # Customers | % of Total | Revenue | % of Revenue |
|---------------|-------------|------------|---------|--------------|
| Top 10 | 10 | 0.08% | $1,088,000 | 34% |
| Top 100 | 100 | 0.80% | $1,664,000 | 52% |
| Top 1,000 | 1,000 | 8.03% | $2,432,000 | 76% |
| Remaining | 11,456 | 91.97% | $768,000 | 24% |

**Top 10 Customers:**

| Rank | Customer | Orders | Revenue | First Order | Last Order |
|------|----------|--------|---------|-------------|------------|
| 1 | Acme Corp | 234 | $187,450 | 2022-03-15 | 2024-01-12 |
| 2 | TechStart Inc | 189 | $156,200 | 2022-05-22 | 2024-01-10 |
| 3 | Global Retail | 145 | $132,800 | 2022-08-01 | 2024-01-08 |
| 4 | Midwest Supply | 167 | $118,900 | 2022-02-14 | 2024-01-11 |
| 5 | Coastal Goods | 123 | $102,340 | 2022-09-30 | 2024-01-05 |
| 6 | Summit Partners | 98 | $98,750 | 2022-04-18 | 2023-12-28 |
| 7 | Valley Traders | 112 | $94,200 | 2022-06-12 | 2024-01-09 |
| 8 | Metro Logistics | 87 | $71,890 | 2022-11-03 | 2023-12-15 |
| 9 | Pine Industries | 76 | $67,230 | 2023-01-20 | 2024-01-07 |
| 10 | Harbor Imports | 69 | $58,240 | 2023-03-08 | 2023-12-22 |

**Risk Assessment:** Loss of top 3 customers would impact 15% of annual revenue.

---

### Finding 3: Product Performance Anomaly

Return rate analysis surfaced a significant outlier:

| Category | Avg Return Rate | Products Above 20% |
|----------|-----------------|-------------------|
| Electronics | 8.2% | 3 |
| Clothing | 12.4% | 7 |
| Home & Garden | 4.1% | 1 |
| Books | 2.3% | 0 |

**Anomaly Detected:** "Widget Pro" has 45% return rate vs 8% category average.

**Investigation:**

| Product | Units Sold | Returns | Return Rate | Avg Rating |
|---------|------------|---------|-------------|------------|
| Widget Pro | 1,234 | 555 | 45.0% | 2.1 |
| Widget Basic | 2,456 | 196 | 8.0% | 4.2 |
| Widget Plus | 1,890 | 170 | 9.0% | 4.0 |

**Return Reasons (from order_notes):**

| Reason | Count | % |
|--------|-------|---|
| "Does not work as described" | 234 | 42% |
| "Quality issues" | 178 | 32% |
| "Missing parts" | 89 | 16% |
| "Wrong item sent" | 54 | 10% |

**Insight:** Widget Pro has manufacturing or fulfillment issues requiring immediate attention. At current pricing ($149.99), returns are costing ~$83K in lost revenue + processing.

---

### Finding 4: Dormant Customer Segment

Customer activity analysis reveals opportunity:

| Segment | Customers | % | Last Purchase |
|---------|-----------|---|---------------|
| Active (< 90 days) | 4,567 | 37% | Recent |
| At-Risk (90-180 days) | 3,234 | 26% | Slipping |
| Dormant (180-365 days) | 2,890 | 23% | Win-back target |
| Churned (> 365 days) | 1,765 | 14% | Likely lost |

**Dormant Customer Profile:**
- Average lifetime value: $342
- Average orders before going dormant: 2.3
- Most common last purchase category: Electronics (47%)

**Win-back Opportunity:** 2,890 dormant customers x $342 LTV = $988K potential recovery

---

### Finding 5: Geographic Distribution

Revenue by region shows expansion opportunity:

```
Northeast ████████████████████████████████████████ 42% ($1.34M)
Southeast ██████████████████████████ 27% ($864K)
Midwest   ████████████████ 17% ($544K)
West      ██████████ 11% ($352K)
Other     ██ 3% ($96K)
```

**Per-Capita Insight:** West region has lowest penetration but highest order value ($92 vs $68 avg).

---

## Data Quality Observations

| Issue | Count | Impact | Recommendation |
|-------|-------|--------|----------------|
| Missing email | 147 | Low | Guest checkout tracking |
| NULL shipping_date | 1,447 | None | Digital products (expected) |
| Duplicate products | 12 | Low | Cleanup recommended |
| Orphaned order_items | 0 | None | Data integrity intact |

---

## Key Takeaways

**Top Finding:** December holiday spike (+57% MoM) masks underlying flat growth trajectory. Excluding December, 2023 revenue grew only 5% YoY.

**Concern:** High customer concentration creates risk. Top 10 customers = 34% of revenue. Loss of top 3 would impact 15% of annual business.

**Opportunity:** Widget Pro returns (45% rate) represent fixable quality issue worth ~$83K annually. Additionally, 2,890 dormant customers represent ~$988K win-back opportunity.

**Next Steps:**
1. Investigate Widget Pro manufacturing and fulfillment chain immediately
2. Develop customer diversification strategy - reduce top-10 dependency
3. Launch win-back campaign targeting dormant segment with personalized offers
4. Analyze West region expansion potential given higher AOV
5. Plan for post-holiday demand stabilization with Q1 promotions

---

## Appendix: Queries Used

```sql
-- Monthly Revenue
SELECT DATE_TRUNC('month', created_at) as month,
       SUM(total) as revenue
FROM orders
WHERE status = 'completed'
GROUP BY 1 ORDER BY 1;

-- Customer Concentration
SELECT customer_id, COUNT(*) as orders, SUM(total) as revenue
FROM orders
WHERE status = 'completed'
GROUP BY 1
ORDER BY revenue DESC;

-- Return Rate by Product
SELECT p.name,
       COUNT(DISTINCT oi.order_id) as units_sold,
       COUNT(DISTINCT CASE WHEN o.status = 'returned' THEN o.id END) as returns
FROM order_items oi
JOIN products p ON oi.product_id = p.id
JOIN orders o ON oi.order_id = o.id
GROUP BY 1;
```

---

*Report generated using exploration workflow. All findings based on data through 2024-01-14.*
