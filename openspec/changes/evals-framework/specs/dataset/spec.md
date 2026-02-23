## ADDED Requirements

### Requirement: Load dataset from inline array

The system SHALL accept a plain JavaScript array as a dataset source. Each element represents one test case.

#### Scenario: Inline array dataset

- **WHEN** user passes an array of objects to the dataset helper
- **THEN** the system returns an async iterable yielding each element in order

### Requirement: Load dataset from JSON file

The system SHALL load datasets from a local JSON file path. The file MUST contain a JSON array.

#### Scenario: JSON file loading

- **WHEN** user passes a file path ending in `.json`
- **THEN** the system reads and parses the file, returning an async iterable of its array elements

#### Scenario: File not found

- **WHEN** user passes a path to a nonexistent file
- **THEN** the system throws a descriptive error including the file path

### Requirement: Load dataset from JSONL file

The system SHALL load datasets from a JSONL file (one JSON object per line).

#### Scenario: JSONL file loading

- **WHEN** user passes a file path ending in `.jsonl`
- **THEN** the system reads each line, parses it as JSON, and yields each object via async iterable

### Requirement: Load dataset from CSV file

The system SHALL load datasets from a CSV file with headers. The first row defines column names.

#### Scenario: CSV file loading

- **WHEN** user passes a file path ending in `.csv`
- **THEN** the system parses the CSV with headers and yields each row as an object

### Requirement: Dataset map transform

The system SHALL support a `map` transform that reshapes each dataset element.

#### Scenario: Mapping dataset elements

- **WHEN** user provides a map function `(row) => ({ input: row.question, expected: row.answer })`
- **THEN** each yielded element is the result of applying the map function

### Requirement: Dataset filter transform

The system SHALL support a `filter` transform that excludes elements not matching a predicate.

#### Scenario: Filtering dataset elements

- **WHEN** user provides a filter function `(row) => row.difficulty === 'hard'`
- **THEN** only elements where the predicate returns true are yielded

### Requirement: Dataset limit transform

The system SHALL support a `limit` transform that caps the number of elements yielded.

#### Scenario: Limiting dataset size

- **WHEN** user sets `limit: 100` on a 10,000 element dataset
- **THEN** the async iterable yields exactly 100 elements and stops

### Requirement: Dataset shuffle transform

The system SHALL buffer the full dataset into memory and yield elements in a randomized order. This is an eager operation — unlike map/filter/limit, it cannot be lazy.

#### Scenario: Shuffling dataset

- **WHEN** user enables `shuffle: true`
- **THEN** the system reads all elements into memory, randomizes their order, and yields them

### Requirement: Dataset sample transform

The system SHALL buffer the full dataset into memory and randomly select N elements. This is an eager operation — unlike map/filter/limit, it cannot be lazy.

#### Scenario: Sampling from dataset

- **WHEN** user sets `sample: 50` on a 10,000 element dataset
- **THEN** the system reads all elements into memory and yields exactly 50 randomly selected elements
