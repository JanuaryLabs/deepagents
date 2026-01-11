# Data Presentation Guidelines

How to format data in report output files for maximum clarity.

## Markdown Tables

```
// STANDARD TABLE FORMAT
| Metric | Value | Change | Context |
|--------|------:|-------:|---------|
| Revenue | $1.2M | +15% | vs last month |
| Users | 45,230 | -3% | seasonal drop |

// ALIGNMENT RULES
column.alignment = {
  text:      left,
  numbers:   right
}

// REQUIRED COLUMNS
table.minimum = [metric_name, current_value, comparison]
```

## ASCII Charts

```
// WHEN TO USE
use_ascii_chart = quick_visualization | pattern_recognition

// HORIZONTAL BAR CHART
Revenue by Month:
Jan ████████████ $120K
Feb ██████████████ $140K
Mar ████████████████████ $200K (+43%)

// HIGHLIGHT ANOMALIES
May ████████ $80K (!!! -69%)   <- investigate

// COMPARISON CHART
Region A ████████████████████ 84%
Region B ████████████ 52%
```

## Key Numbers Summary

```markdown
### At a Glance
- Total Records: 1,234,567
- Date Range: 2023-01-01 to 2024-12-31
- Active Users: 45,231 (up 12% MoM)

// PLACEMENT: top of report
// MAX ITEMS: 5-7 key metrics
```

## Number Formatting

```
format.thousands = "1,234" or "1.2K"
format.millions = "1.2M"
format.percentage = "15.3%"
format.percentage_points = "+0.8pp"
format.currency = "$1,234" or "$1.2M"

// DIRECTION INDICATORS
change.positive = "+15%"
change.negative = "-8%"
```

## Table Size Limits

```
table.max_rows_inline = 20

on table(rows: >20):
  show = top_20
  note = "Showing top 20 of {total} results"
  link = appendix_with_full_data
```

## Highlighting Important Data

```
highlight.methods = [
  bold_text:      "**Revenue grew 15%**",
  inline_note:    "Revenue: $1.2M (best quarter)",
  separate_line:  "> Key finding: conversion up 40%"
]

anomaly.markers = [
  exclamation:    "!!! -69%",
  arrow:          "<- investigate"
]
```
