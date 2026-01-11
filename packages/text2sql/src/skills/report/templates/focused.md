# Focused Analysis Workflow

Answer one business question deeply with supporting evidence.

## When to Use

```
use_focused_when = {
  specific_question:  "why did sales drop last month?",
  clear_metric:       "what's our customer retention rate?",
  hypothesis_testing: "are premium users more profitable?"
}
// ANTI-PATTERN: open_exploration → use exploration.md
```

## The Focused Mindset

```
focused_mode = {
  one_question:     true,      // resist scope creep
  complete_answer:  true,      // don't stop at surface
  confidence_level: required,  // "definitely" vs "probably"
  evidence_based:   true       // every claim backed by data
}
```

## Phase 1: Question Decomposition

```
decompose(question) = {
  core_metric:   what_number_answers_this,
  sub_questions: what_else_needs_answering,
  definitions:   what_do_terms_mean_exactly,
  timeframe:     what_period_are_we_analyzing
}
// ambiguous question → wrong answer
```

## Phase 2: Relevant Table Identification

```
table_selection = {
  primary:    tables_that_directly_answer_question,
  supporting: tables_that_provide_context,
  ignore:     everything_else
}
```

## Phase 3: Core Metrics Extraction

```
core_answer = {
  the_number: calculate_exactly,
  comparison: vs_baseline_or_benchmark,
  magnitude:  how_big_is_this
}
```

## Phase 4: Supporting Analysis

```
supporting_analysis = {
  segmentation: where_is_the_drop_concentrated,
  timeline:     when_exactly_did_it_happen,
  comparison:   is_this_unusual_historically,
  correlation:  what_else_changed
}
```

## Phase 5: Validation

```
validation = {
  data_quality: are_there_issues_affecting_accuracy,
  completeness: is_data_complete_for_this_period,
  alternatives: could_another_explanation_fit
}
```

## Phase 6: Synthesis

```
synthesis_format = {
  answer:         direct_response_to_question,
  confidence:     high | medium | low,
  evidence:       supporting_data_points,
  caveats:        limitations_and_assumptions,
  recommendation: suggested_action
}

confidence = {
  high:   "data complete, pattern clear",
  medium: "strong signal, some uncertainty",
  low:    "multiple explanations possible"
}
```

## Example Flow

```
user: "Why did our customer retention drop this quarter?"

flow = [
  // Phase 1: Decomposition
  → "Retention = repeat order within 90 days, Q4 vs Q3"

  // Phase 2: Table selection
  → primary: [orders, users]

  // Phase 3: Core metrics
  → "Q4 retention: 34% (was 42% in Q3), down 8pp"

  // Phase 4: Supporting analysis
  → segment:   "New customers -12%, Existing -2%"
  → correlate: "New product launch attracted deal-seekers"

  // Phase 5: Validation
  → "Data complete. Alternative: holiday one-time buyers?"

  // Phase 6: Synthesis
  → "Retention dropped 8pp in new customers.
     Root cause: Oct launch attracted deal-seekers.
     Confidence: high."
]
```
