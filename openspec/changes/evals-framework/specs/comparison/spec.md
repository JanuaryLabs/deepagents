## ADDED Requirements

### Requirement: Case-by-case diff between two runs

The comparison module SHALL accept two run IDs and produce a per-case, per-scorer diff. For each dataset index, the diff shows score changes for each scorer independently.

#### Scenario: Compare two runs with multiple scorers

- **WHEN** run A case #5 has scores exactMatch=1.0, llmJudge=0.6 and run B case #5 has scores exactMatch=1.0, llmJudge=0.9
- **THEN** the diff shows case #5 exactMatch as "unchanged" (delta 0) and llmJudge as "improved" (delta +0.3)

#### Scenario: Matching by dataset index

- **WHEN** two runs used the same dataset
- **THEN** cases are matched by their `index` field (position in dataset)

#### Scenario: Mismatched case counts

- **WHEN** run A has 100 cases and run B has 80 cases
- **THEN** the comparison logs a warning and diffs only the intersection of indices (0..79)

### Requirement: Categorize case changes

Each case in the diff SHALL be categorized as `improved`, `regressed`, or `unchanged` based on a configurable tolerance (default: 0.01).

#### Scenario: Case within tolerance

- **WHEN** run A scored 0.80 and run B scored 0.805 with tolerance 0.01
- **THEN** the case is categorized as `unchanged`

#### Scenario: Case regressed

- **WHEN** run A scored 0.9 and run B scored 0.6
- **THEN** the case is categorized as `regressed` with delta -0.3

### Requirement: Aggregate score deltas

The comparison SHALL compute aggregate metrics: mean score change per scorer, number of improved/regressed/unchanged cases.

#### Scenario: Aggregate summary

- **WHEN** comparing two runs of 100 cases
- **THEN** the result includes mean delta, count of improved/regressed/unchanged, and per-scorer breakdowns

### Requirement: Cost and token deltas

The comparison SHALL compute differences in total tokens (input + output) and total latency between the two runs.

#### Scenario: Cost comparison

- **WHEN** run A used 500k total tokens and run B used 300k total tokens
- **THEN** the comparison shows token delta of -200k (run B is cheaper)

### Requirement: Regression detection

The comparison SHALL provide a method to check if run B regressed from run A, defined as: mean score decreased beyond a configurable threshold.

#### Scenario: Regression detected

- **WHEN** run A mean score is 0.85 and run B mean score is 0.78 with regression threshold 0.05
- **THEN** the comparison flags this as a regression

#### Scenario: No regression

- **WHEN** run A mean score is 0.85 and run B mean score is 0.83 with regression threshold 0.05
- **THEN** the comparison does NOT flag a regression (delta 0.02 < threshold 0.05)
