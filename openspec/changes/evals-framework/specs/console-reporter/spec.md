## ADDED Requirements

### Requirement: Subscribe to engine events

The console reporter SHALL subscribe to engine events (`run:start`, `case:start`, `case:scored`, `case:error`, `run:end`) and render terminal output.

#### Scenario: Reporter attaches to engine

- **WHEN** user creates a console reporter and passes the engine's event emitter
- **THEN** the reporter begins listening for events and rendering output

### Requirement: Progress display during execution

The reporter SHALL display a progress indicator showing completed/total cases during engine execution.

#### Scenario: Running 100 cases

- **WHEN** 45 of 100 cases have completed
- **THEN** the terminal shows progress like `[45/100]` or a progress bar

### Requirement: Summary table on run completion

The reporter SHALL print a summary table when `run:end` fires, including: eval name, model, total cases, mean score per scorer, pass/fail count, total duration, total tokens.

#### Scenario: Run completes

- **WHEN** the engine emits `run:end`
- **THEN** the reporter prints a formatted table with aggregate stats

### Requirement: Failing case details

The reporter SHALL print details for each failing case (score below threshold), including: case index, input (truncated), output (truncated), expected (truncated), scorer name, score, and reason.

#### Scenario: Three cases failed

- **WHEN** 3 cases scored below the threshold
- **THEN** the reporter prints each failing case with its input/output/expected and the scorer's reason

### Requirement: Configurable verbosity

The reporter SHALL support a verbosity level: `quiet` (summary only), `normal` (summary + failures), `verbose` (summary + all cases).

#### Scenario: Quiet mode

- **WHEN** verbosity is `quiet`
- **THEN** only the summary table is printed, no individual case details

#### Scenario: Verbose mode

- **WHEN** verbosity is `verbose`
- **THEN** every case is printed with its scores, not just failures
