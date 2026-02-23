## ADDED Requirements

### Requirement: Scorer interface

All scorers SHALL implement the signature `(args: { input: unknown, output: string, expected?: unknown }) => Promise<{ score: number, reason?: string }>`. The `score` MUST be a number between 0 and 1 inclusive.

#### Scenario: Scorer returns valid result

- **WHEN** a scorer is invoked with input, output, and expected
- **THEN** it returns an object with `score` (0..1) and optional `reason` string

#### Scenario: Score out of range

- **WHEN** a scorer implementation returns a score outside 0..1
- **THEN** the engine clamps it to the valid range and logs a warning

### Requirement: exactMatch scorer

The system SHALL provide an `exactMatch` scorer that returns 1.0 when output strictly equals expected, 0.0 otherwise. If `expected` is not a string, it is coerced to string via `String(expected)`.

#### Scenario: Exact match success

- **WHEN** output is `"SELECT * FROM users"` and expected is `"SELECT * FROM users"`
- **THEN** score is 1.0

#### Scenario: Exact match failure

- **WHEN** output is `"SELECT * FROM users"` and expected is `"select * from users"`
- **THEN** score is 0.0

### Requirement: includes scorer

The system SHALL provide an `includes` scorer that returns 1.0 when output contains the expected string, 0.0 otherwise. If `expected` is not a string, it is coerced to string via `String(expected)`.

#### Scenario: Includes match

- **WHEN** output is `"The answer is 42."` and expected is `"42"`
- **THEN** score is 1.0

### Requirement: regex scorer

The system SHALL provide a `regex` scorer factory that takes a pattern at creation time and returns a scorer. The returned scorer tests the output against the pattern and returns 1.0 on match, 0.0 otherwise. The `expected` argument is unused by this scorer.

#### Scenario: Regex match

- **WHEN** scorer is created via `regex(/^SELECT .+ FROM .+/i)` and output is `"SELECT id FROM users WHERE age > 21"`
- **THEN** score is 1.0

### Requirement: levenshtein scorer

The system SHALL provide a `levenshtein` scorer that returns a normalized similarity score (0..1) based on edit distance between output and expected. If `expected` is not a string, it is coerced to string via `String(expected)`.

#### Scenario: Similar strings

- **WHEN** output is `"hello world"` and expected is `"hello worlb"`
- **THEN** score is close to 1.0 (high similarity)

#### Scenario: Completely different strings

- **WHEN** output is `"abc"` and expected is `"xyz"`
- **THEN** score is close to 0.0 (low similarity)

### Requirement: jsonMatch scorer

The system SHALL provide a `jsonMatch` scorer that parses both output and expected as JSON and performs deep structural equality. Returns 1.0 on match, 0.0 otherwise.

#### Scenario: JSON structural match

- **WHEN** output is `{"a":1,"b":2}` and expected is `{"b":2,"a":1}`
- **THEN** score is 1.0 (key order does not matter)

#### Scenario: Output is not valid JSON

- **WHEN** output is `"not json"` and expected is `{"a":1}`
- **THEN** score is 0.0

### Requirement: llmJudge scorer

The system SHALL provide an `llmJudge` scorer factory that takes a `model` and `criteria` string. It sends the input/output/expected to the model with the criteria as a rubric and returns a 0..1 score.

#### Scenario: LLM judges output as good

- **WHEN** criteria is `"Is the SQL query semantically equivalent to the expected?"` and the model determines equivalence
- **THEN** score is 1.0 with a reason explaining the judgment

#### Scenario: User-configured model

- **WHEN** user creates `llmJudge({ model: openai('gpt-4o-mini'), criteria: '...' })`
- **THEN** the scorer uses the provided model for judging, not a hardcoded default

### Requirement: factuality scorer

The system SHALL provide a `factuality` scorer factory that takes a `model` and checks whether the output is factually consistent with the expected reference.

#### Scenario: Factually consistent output

- **WHEN** expected is `"Paris is the capital of France"` and output is `"The capital of France is Paris"`
- **THEN** score is 1.0

### Requirement: sqlMatch scorer

The system SHALL provide a `sqlMatch` scorer factory that takes a `model` and checks semantic equivalence of SQL queries.

#### Scenario: Semantically equivalent SQL

- **WHEN** output is `"SELECT * FROM users WHERE age >= 18"` and expected is `"SELECT * FROM users WHERE age > 17"`
- **THEN** score is 1.0

### Requirement: Scorer composition with all()

The system SHALL provide an `all()` combinator that runs multiple scorers and returns the minimum score across all scorers (weakest link).

#### Scenario: All scorers pass

- **WHEN** scorer A returns 0.9 and scorer B returns 0.8
- **THEN** combined score is 0.8 (minimum)

#### Scenario: One scorer fails

- **WHEN** scorer A returns 0.9 and scorer B returns 0.0
- **THEN** combined score is 0.0

### Requirement: Scorer composition with any()

The system SHALL provide an `any()` combinator that runs multiple scorers and returns the maximum score (any must pass).

#### Scenario: One scorer passes

- **WHEN** scorer A returns 0.0 and scorer B returns 0.8
- **THEN** combined score is 0.8 (maximum)

### Requirement: Scorer composition with weighted()

The system SHALL provide a `weighted()` combinator that takes named scorers with weights and returns a weighted average. Weights are normalized by their sum (they do not need to sum to 1.0).

#### Scenario: Weighted average with normalized weights

- **WHEN** scorer "accuracy" (weight 0.7) returns 1.0 and scorer "style" (weight 0.3) returns 0.5
- **THEN** combined score is 0.85 ((0.7*1.0 + 0.3*0.5) / (0.7+0.3))

#### Scenario: Weights not summing to 1

- **WHEN** scorer "a" (weight 2) returns 1.0 and scorer "b" (weight 3) returns 0.5
- **THEN** combined score is 0.7 ((2*1.0 + 3*0.5) / (2+3) = 3.5/5)
