import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from 'node:sqlite';

import DDL from './ddl.sqlite.sql';

export interface SuiteRow {
  id: string;
  name: string;
  created_at: number;
}

export interface RunRow {
  id: string;
  suite_id: string;
  name: string;
  model: string;
  config: Record<string, unknown> | null;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  summary: RunSummary | null;
}

export interface CaseRow {
  id: string;
  run_id: string;
  idx: number;
  input: unknown;
  output: string | null;
  expected: unknown | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  error: string | null;
}

export interface CaseWithScores extends CaseRow {
  scores: Array<{ scorer_name: string; score: number; reason: string | null }>;
}

export interface ScoreRow {
  id: string;
  case_id: string;
  scorer_name: string;
  score: number;
  reason: string | null;
}

export interface RunSummary {
  totalCases: number;
  passCount: number;
  failCount: number;
  meanScores: Record<string, number>;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export interface PromptRow {
  id: string;
  name: string;
  version: number;
  content: string;
  created_at: number;
}

export interface CaseData {
  id: string;
  run_id: string;
  idx: number;
  input: unknown;
  output: string | null;
  expected?: unknown;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  error?: string;
}

export interface ScoreData {
  id: string;
  case_id: string;
  scorer_name: string;
  score: number;
  reason?: string;
}

const RUN_STATUSES = ['running', 'completed', 'failed'] as const;

type RunStatus = (typeof RUN_STATUSES)[number];

function isRunStatus(value: string): value is RunStatus {
  return RUN_STATUSES.some((status) => status === value);
}

type SqlRow = Record<string, SQLOutputValue>;

/** What node:sqlite returns for each kind of column the store reads. */
interface ColumnTypes {
  text: string;
  'text?': string | null;
  number: number;
  'number?': number | null;
}

type ColumnType = keyof ColumnTypes;

type Columns = Readonly<Record<string, ColumnType>>;

type RowOf<C extends Columns> = { -readonly [K in keyof C]: ColumnTypes[C[K]] };

function matchesColumn(
  value: SQLOutputValue | undefined,
  type: ColumnType,
): boolean {
  switch (type) {
    case 'text':
      return typeof value === 'string';
    case 'text?':
      return value === null || typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'number?':
      return value === null || typeof value === 'number';
  }
}

function mismatchedColumns(row: SqlRow, columns: Columns): string[] {
  return Object.entries(columns)
    .filter(([name, type]) => !matchesColumn(row[name], type))
    .map(([name]) => name);
}

function hasColumns<C extends Columns>(
  row: SqlRow,
  columns: C,
): row is SqlRow & RowOf<C> {
  return mismatchedColumns(row, columns).length === 0;
}

function readRow<C extends Columns>(
  row: SqlRow,
  columns: C,
  sql: string,
): RowOf<C> {
  if (hasColumns(row, columns)) return row;
  throw new TypeError(
    `Unexpected values in columns ${mismatchedColumns(row, columns).join(', ')} of a row from: ${oneLine(sql)}`,
  );
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunSummary(value: unknown): value is RunSummary {
  return (
    isRecord(value) &&
    typeof value.totalCases === 'number' &&
    typeof value.passCount === 'number' &&
    typeof value.failCount === 'number' &&
    typeof value.totalLatencyMs === 'number' &&
    typeof value.totalTokensIn === 'number' &&
    typeof value.totalTokensOut === 'number' &&
    isRecord(value.meanScores) &&
    Object.values(value.meanScores).every((score) => typeof score === 'number')
  );
}

function parseJson<T>(
  text: string,
  guard: (value: unknown) => value is T,
  source: string,
): T {
  const value: unknown = JSON.parse(text);
  if (guard(value)) return value;
  throw new TypeError(`Unexpected JSON in ${source}`);
}

const suiteColumns = {
  id: 'text',
  name: 'text',
  created_at: 'number',
} as const;

const runColumns = {
  id: 'text',
  suite_id: 'text',
  name: 'text',
  model: 'text',
  config: 'text?',
  started_at: 'number',
  finished_at: 'number?',
  status: 'text',
  summary: 'text?',
} as const;

const caseColumns = {
  id: 'text',
  run_id: 'text',
  idx: 'number',
  input: 'text',
  output: 'text?',
  expected: 'text?',
  latency_ms: 'number?',
  tokens_in: 'number?',
  tokens_out: 'number?',
  error: 'text?',
} as const;

const promptColumns = {
  id: 'text',
  name: 'text',
  version: 'number',
  content: 'text',
  created_at: 'number',
} as const;

function toSuite(row: RowOf<typeof suiteColumns>): SuiteRow {
  return { id: row.id, name: row.name, created_at: row.created_at };
}

function toRun(row: RowOf<typeof runColumns>): RunRow {
  if (!isRunStatus(row.status)) {
    throw new TypeError(`Unexpected status "${row.status}" of run ${row.id}`);
  }
  return {
    id: row.id,
    suite_id: row.suite_id,
    name: row.name,
    model: row.model,
    config: row.config
      ? parseJson(row.config, isRecord, `config of run ${row.id}`)
      : null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    summary: row.summary
      ? parseJson(row.summary, isRunSummary, `summary of run ${row.id}`)
      : null,
  };
}

function toCase(row: RowOf<typeof caseColumns>): CaseRow {
  const input: unknown = JSON.parse(row.input);
  const expected: unknown = row.expected ? JSON.parse(row.expected) : null;
  return {
    id: row.id,
    run_id: row.run_id,
    idx: row.idx,
    input,
    output: row.output,
    expected,
    latency_ms: row.latency_ms,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    error: row.error,
  };
}

function toPrompt(row: RowOf<typeof promptColumns>): PromptRow {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    content: row.content,
    created_at: row.created_at,
  };
}

export class RunStore {
  #db: DatabaseSync;
  #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  #stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  #get<const C extends Columns>(
    columns: C,
    sql: string,
    ...params: SQLInputValue[]
  ): RowOf<C> | undefined {
    const row = this.#stmt(sql).get(...params);
    return row === undefined ? undefined : readRow(row, columns, sql);
  }

  /** Reads an aggregate query, which returns exactly one row. */
  #one<const C extends Columns>(
    columns: C,
    sql: string,
    ...params: SQLInputValue[]
  ): RowOf<C> {
    const row = this.#get(columns, sql, ...params);
    if (row === undefined) {
      throw new Error(`Expected one row from: ${oneLine(sql)}`);
    }
    return row;
  }

  #all<const C extends Columns>(
    columns: C,
    sql: string,
    ...params: SQLInputValue[]
  ): RowOf<C>[] {
    return this.#stmt(sql)
      .all(...params)
      .map((row) => readRow(row, columns, sql));
  }

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Preserve the operation error when SQLite already ended the transaction.
      }
      throw error;
    }
  }

  constructor(pathOrDb?: string | DatabaseSync) {
    if (pathOrDb instanceof DatabaseSync) {
      this.#db = pathOrDb;
    } else {
      const dbPath = pathOrDb ?? '.evals/store.db';
      mkdirSync(dirname(dbPath), { recursive: true });
      this.#db = new DatabaseSync(dbPath);
    }
    this.#db.exec(DDL);
    this.#migrateRunsTableToSuiteRequired();
    this.#migratePromptsTableIfNeeded();
    this.#db.exec(
      'CREATE INDEX IF NOT EXISTS idx_prompts_name_version ON prompts(name, version DESC)',
    );
  }

  #migratePromptsTableIfNeeded(): void {
    const columns = this.#all({ name: 'text' }, 'PRAGMA table_info(prompts)');

    if (columns.length === 0) return;
    if (columns.some((column) => column.name === 'version')) return;

    this.#transaction(() => {
      this.#db.exec('ALTER TABLE prompts RENAME TO prompts_legacy');
      this.#db.exec(`
        CREATE TABLE prompts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          version INTEGER NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          UNIQUE(name, version)
        )
      `);
      this.#db.exec(`
        INSERT INTO prompts (id, name, version, content, created_at)
        SELECT id, name, 1, content, created_at
        FROM prompts_legacy
      `);
      this.#db.exec('DROP TABLE prompts_legacy');
      this.#db.exec(
        'CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON prompts(created_at)',
      );
      this.#db.exec(
        'CREATE INDEX IF NOT EXISTS idx_prompts_name_version ON prompts(name, version DESC)',
      );
    });
  }

  #migrateRunsTableToSuiteRequired(): void {
    const columns = this.#all(
      { name: 'text', notnull: 'number' },
      'PRAGMA table_info(runs)',
    );

    if (columns.length === 0) return;

    const suiteColumn = columns.find((column) => column.name === 'suite_id');
    const hasNonNullSuite = suiteColumn?.notnull === 1;

    const runForeignKeys = this.#all(
      { from: 'text', on_delete: 'text', table: 'text' },
      'PRAGMA foreign_key_list(runs)',
    );
    const suiteForeignKey = runForeignKeys.find(
      (fk) => fk.from === 'suite_id' && fk.table === 'suites',
    );
    const hasCascadeDelete = suiteForeignKey?.on_delete === 'CASCADE';

    if (hasNonNullSuite && hasCascadeDelete) return;

    this.#statements.clear();
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE runs_next (
          id TEXT PRIMARY KEY,
          suite_id TEXT NOT NULL,
          name TEXT NOT NULL,
          model TEXT NOT NULL,
          config TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
          summary TEXT,
          FOREIGN KEY (suite_id) REFERENCES suites(id) ON DELETE CASCADE
        )
      `);

      // Drop legacy orphaned runs that do not belong to a suite.
      this.#db.exec('DELETE FROM runs WHERE suite_id IS NULL');

      this.#db.exec(`
        INSERT INTO runs_next (id, suite_id, name, model, config, started_at, finished_at, status, summary)
        SELECT r.id, r.suite_id, r.name, r.model, r.config, r.started_at, r.finished_at, r.status, r.summary
        FROM runs r
        JOIN suites s ON s.id = r.suite_id
      `);

      this.#db.exec('DROP TABLE runs');
      this.#db.exec('ALTER TABLE runs_next RENAME TO runs');
      this.#db.exec(
        'CREATE INDEX IF NOT EXISTS idx_runs_suite_id ON runs(suite_id)',
      );
      this.#db.exec(
        'CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at)',
      );
    });
    this.#statements.clear();
  }

  createSuite(name: string): SuiteRow {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#stmt(
      'INSERT INTO suites (id, name, created_at) VALUES (?, ?, ?)',
    ).run(id, name, now);
    return { id, name, created_at: now };
  }

  getSuite(id: string): SuiteRow | undefined {
    const row = this.#get(
      suiteColumns,
      'SELECT * FROM suites WHERE id = ?',
      id,
    );
    return row ? toSuite(row) : undefined;
  }

  renameSuite(id: string, name: string): void {
    this.#stmt('UPDATE suites SET name = ? WHERE id = ?').run(name, id);
  }

  renameRun(id: string, name: string): void {
    this.#stmt('UPDATE runs SET name = ? WHERE id = ?').run(name, id);
  }

  createRun(run: {
    suite_id: string;
    name: string;
    model: string;
    config?: Record<string, unknown>;
  }): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.#stmt(
      'INSERT INTO runs (id, suite_id, name, model, config, started_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      run.suite_id,
      run.name,
      run.model,
      run.config ? JSON.stringify(run.config) : null,
      now,
    );
    return id;
  }

  finishRun(
    runId: string,
    status: 'completed' | 'failed',
    summary?: RunSummary,
  ): void {
    this.#stmt(
      'UPDATE runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?',
    ).run(Date.now(), status, summary ? JSON.stringify(summary) : null, runId);
  }

  saveCases(cases: CaseData[]): void {
    this.#transaction(() => {
      const stmt = this.#stmt(
        'INSERT INTO cases (id, run_id, idx, input, output, expected, latency_ms, tokens_in, tokens_out, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const c of cases) {
        stmt.run(
          c.id,
          c.run_id,
          c.idx,
          JSON.stringify(c.input),
          c.output,
          c.expected != null ? JSON.stringify(c.expected) : null,
          c.latency_ms,
          c.tokens_in,
          c.tokens_out,
          c.error ?? null,
        );
      }
    });
  }

  saveScores(scores: ScoreData[]): void {
    this.#transaction(() => {
      const stmt = this.#stmt(
        'INSERT INTO scores (id, case_id, scorer_name, score, reason) VALUES (?, ?, ?, ?, ?)',
      );
      for (const s of scores) {
        stmt.run(s.id, s.case_id, s.scorer_name, s.score, s.reason ?? null);
      }
    });
  }

  getRun(runId: string): RunRow | undefined {
    const row = this.#get(runColumns, 'SELECT * FROM runs WHERE id = ?', runId);
    return row ? toRun(row) : undefined;
  }

  listRuns(suiteId?: string): RunRow[] {
    const rows = suiteId
      ? this.#all(
          runColumns,
          'SELECT * FROM runs WHERE suite_id = ? ORDER BY started_at',
          suiteId,
        )
      : this.#all(runColumns, 'SELECT * FROM runs ORDER BY started_at');
    return rows.map(toRun);
  }

  getCases(runId: string): CaseRow[] {
    return this.#all(
      caseColumns,
      'SELECT * FROM cases WHERE run_id = ? ORDER BY idx',
      runId,
    ).map(toCase);
  }

  getFailingCases(runId: string, threshold = 0.5): CaseWithScores[] {
    const rows = this.#all(
      {
        ...caseColumns,
        scorer_name: 'text',
        score: 'number',
        score_reason: 'text?',
      },
      `SELECT c.*, s.scorer_name, s.score, s.reason as score_reason
       FROM cases c
       JOIN scores s ON s.case_id = c.id
       WHERE c.run_id = ? AND s.score < ?
       ORDER BY c.idx`,
      runId,
      threshold,
    );

    const caseMap = new Map<string, CaseWithScores>();
    for (const row of rows) {
      let c = caseMap.get(row.id);
      if (!c) {
        c = { ...toCase(row), scores: [] };
        caseMap.set(row.id, c);
      }
      c.scores.push({
        scorer_name: row.scorer_name,
        score: row.score,
        reason: row.score_reason,
      });
    }
    return Array.from(caseMap.values());
  }

  getRunSummary(runId: string, threshold = 0.5): RunSummary {
    const totals = this.#one(
      {
        totalCases: 'number',
        totalLatencyMs: 'number',
        totalTokensIn: 'number',
        totalTokensOut: 'number',
      },
      `SELECT
        COUNT(DISTINCT c.id) as totalCases,
        COALESCE(SUM(c.latency_ms), 0) as totalLatencyMs,
        COALESCE(SUM(c.tokens_in), 0) as totalTokensIn,
        COALESCE(SUM(c.tokens_out), 0) as totalTokensOut
       FROM cases c WHERE c.run_id = ?`,
      runId,
    );

    const scorerMeans = this.#all(
      { scorer_name: 'text', meanScore: 'number' },
      `SELECT s.scorer_name, AVG(s.score) as meanScore
       FROM scores s
       JOIN cases c ON c.id = s.case_id
       WHERE c.run_id = ?
       GROUP BY s.scorer_name`,
      runId,
    );

    const meanScores: Record<string, number> = {};
    for (const row of scorerMeans) {
      meanScores[row.scorer_name] = row.meanScore;
    }

    const passFail = this.#all(
      { id: 'text', minScore: 'number' },
      `SELECT c.id,
        MIN(s.score) as minScore
       FROM cases c
       JOIN scores s ON s.case_id = c.id
       WHERE c.run_id = ?
       GROUP BY c.id`,
      runId,
    );

    let passCount = 0;
    let failCount = 0;
    for (const row of passFail) {
      if (row.minScore >= threshold) passCount++;
      else failCount++;
    }

    return {
      totalCases: totals.totalCases,
      passCount,
      failCount,
      meanScores,
      totalLatencyMs: totals.totalLatencyMs,
      totalTokensIn: totals.totalTokensIn,
      totalTokensOut: totals.totalTokensOut,
    };
  }

  findSuiteByName(name: string): SuiteRow | undefined {
    const row = this.#get(
      suiteColumns,
      'SELECT * FROM suites WHERE name = ? ORDER BY created_at DESC LIMIT 1',
      name,
    );
    return row ? toSuite(row) : undefined;
  }

  getLatestCompletedRun(suiteId: string, model?: string): RunRow | undefined {
    const row = model
      ? this.#get(
          runColumns,
          'SELECT * FROM runs WHERE suite_id = ? AND status = ? AND model = ? ORDER BY started_at DESC LIMIT 1',
          suiteId,
          'completed',
          model,
        )
      : this.#get(
          runColumns,
          'SELECT * FROM runs WHERE suite_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1',
          suiteId,
          'completed',
        );
    return row ? toRun(row) : undefined;
  }

  listSuites(): SuiteRow[] {
    return this.#all(
      suiteColumns,
      'SELECT * FROM suites ORDER BY created_at DESC',
    ).map(toSuite);
  }

  createPrompt(name: string, content: string): PromptRow {
    const id = crypto.randomUUID();
    const now = Date.now();

    const { latestVersion } = this.#one(
      { latestVersion: 'number?' },
      'SELECT MAX(version) as latestVersion FROM prompts WHERE name = ?',
      name,
    );
    const version = (latestVersion ?? 0) + 1;

    this.#stmt(
      'INSERT INTO prompts (id, name, version, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, version, content, now);
    return { id, name, version, content, created_at: now };
  }

  listPrompts(): PromptRow[] {
    return this.#all(
      promptColumns,
      'SELECT * FROM prompts ORDER BY name COLLATE NOCASE ASC, version DESC',
    ).map(toPrompt);
  }

  getPrompt(id: string): PromptRow | undefined {
    const row = this.#get(
      promptColumns,
      'SELECT * FROM prompts WHERE id = ?',
      id,
    );
    return row ? toPrompt(row) : undefined;
  }

  deletePrompt(id: string): void {
    this.#stmt('DELETE FROM prompts WHERE id = ?').run(id);
  }

  resetRun(id: string): void {
    this.#transaction(() => {
      this.#stmt('DELETE FROM cases WHERE run_id = ?').run(id);
      this.#stmt(
        'UPDATE runs SET status = ?, started_at = ?, finished_at = NULL, summary = NULL WHERE id = ?',
      ).run('running', Date.now(), id);
    });
  }

  deleteRun(id: string): void {
    this.#stmt('DELETE FROM runs WHERE id = ?').run(id);
  }

  deleteSuite(id: string): void {
    this.#stmt('DELETE FROM suites WHERE id = ?').run(id);
  }
}
