# Deep-Dive Strategies

When and how to investigate findings further.

## The Deep-Dive Trigger

```
when finding.is_interesting:
  immediately drill_down()    // don't wait for report end
  no_depth_limit              // keep going until stable
  track_investigation_path    // document the journey
```

## Drill-Down Dimensions

```
// STANDARD DIMENSIONS TO EXPLORE
dimensions = {
  time:       "When did this start/change?",
  segment:    "Who is affected?",
  category:   "Which products/types?",
  geography:  "Where is this happening?",
  channel:    "How did they arrive?"
}

select_dimension = match(finding_type) {
  sudden_change:    start_with(time),
  performance_gap:  start_with(segment),
  volume_shift:     start_with(category)
}
```

## Investigation Pattern

```
finding = "Sales dropped 30% in March"

investigation = [
  by_product:     "Product X dropped 80%"
    by_region:    "Only West region"
      by_channel: "Only online channel"
        events:   "Website outage March 5-12"

  conclusion: "Website outage caused drop"
]

// PATTERN: narrowing funnel
broad_observation -> specific_segment -> root_cause
```

## When to Stop Drilling

```
stop_drilling.when = {
  root_cause_found:     "Identified specific event/change",
  finding_stabilizes:   "Further breakdown shows same pattern",
  data_too_sparse:      "Not enough records for analysis",
  actionable_reached:   "Have enough to make a decision"
}
```

## Documenting the Path

```
investigation.log = {
  trigger:    "What started this investigation?",
  hypothesis: "What did we think might explain it?",
  finding:    "What did we learn?",
  next_step:  "What did this lead us to explore?"
}

// EXAMPLE
## Investigation: March Revenue Drop

**Trigger:** Revenue down 30% in March
**Path:**
1. By product -> Product X down 80%
2. Product X by region -> West only
3. West by channel -> Online only (-95%)
4. Timeline -> Cliff on March 5
5. Events -> Website outage March 5-12

**Root Cause:** 7-day website outage
```

## Dead Ends

```
on investigation_stalled:
  document = {
    what_we_know:    "Facts established",
    what_we_tried:   "Hypotheses tested",
    what_remains:    "Unexplained portion",
    recommendation:  "Manual review needed"
  }
```
