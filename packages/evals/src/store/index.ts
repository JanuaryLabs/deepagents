import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
  status: 'running' | 'completed' | 'failed';
  summary: RunSummary | null;
}

export interface CaseRow {
  id: string;
  run_id: string;
  idx: number;
  input: unknown;
  output: string | null;
  expected: unknown | null;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
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

  #transaction<T>(fn: () => T): T {
    this.#db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
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
    const columns = this.#stmt('PRAGMA table_info(prompts)').all() as Array<{
      name: string;
    }>;

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
    const runColumns = this.#stmt('PRAGMA table_info(runs)').all() as Array<{
      name: string;
      notnull: number;
    }>;

    if (runColumns.length === 0) return;

    const suiteColumn = runColumns.find((column) => column.name === 'suite_id');
    const hasNonNullSuite = suiteColumn?.notnull === 1;

    const runForeignKeys = this.#stmt(
      'PRAGMA foreign_key_list(runs)',
    ).all() as Array<{
      from: string;
      on_delete: string;
      table: string;
    }>;
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
    const row = this.#stmt('SELECT * FROM runs WHERE id = ?').get(runId) as
      | {
          id: string;
          suite_id: string;
          name: string;
          model: string;
          config: string | null;
          started_at: number;
          finished_at: number | null;
          status: string;
          summary: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      suite_id: row.suite_id,
      name: row.name,
      model: row.model,
      config: row.config ? JSON.parse(row.config) : null,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status as RunRow['status'],
      summary: row.summary ? JSON.parse(row.summary) : null,
    };
  }

  listRuns(suiteId?: string): RunRow[] {
    const sql = suiteId
      ? 'SELECT * FROM runs WHERE suite_id = ? ORDER BY started_at'
      : 'SELECT * FROM runs ORDER BY started_at';
    const rows = (
      suiteId ? this.#stmt(sql).all(suiteId) : this.#stmt(sql).all()
    ) as Array<{
      id: string;
      suite_id: string;
      name: string;
      model: string;
      config: string | null;
      started_at: number;
      finished_at: number | null;
      status: string;
      summary: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      suite_id: row.suite_id,
      name: row.name,
      model: row.model,
      config: row.config ? JSON.parse(row.config) : null,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status as RunRow['status'],
      summary: row.summary ? JSON.parse(row.summary) : null,
    }));
  }

  getCases(runId: string): CaseRow[] {
    const rows = this.#stmt(
      'SELECT * FROM cases WHERE run_id = ? ORDER BY idx',
    ).all(runId) as Array<{
      id: string;
      run_id: string;
      idx: number;
      input: string;
      output: string | null;
      expected: string | null;
      latency_ms: number;
      tokens_in: number;
      tokens_out: number;
      error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      run_id: row.run_id,
      idx: row.idx,
      input: JSON.parse(row.input),
      output: row.output,
      expected: row.expected ? JSON.parse(row.expected) : null,
      latency_ms: row.latency_ms,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      error: row.error,
    }));
  }

  getFailingCases(runId: string, threshold = 0.5): CaseWithScores[] {
    const rows = this.#stmt(
      `SELECT c.*, s.scorer_name, s.score, s.reason as score_reason
       FROM cases c
       JOIN scores s ON s.case_id = c.id
       WHERE c.run_id = ? AND s.score < ?
       ORDER BY c.idx`,
    ).all(runId, threshold) as Array<{
      id: string;
      run_id: string;
      idx: number;
      input: string;
      output: string | null;
      expected: string | null;
      latency_ms: number;
      tokens_in: number;
      tokens_out: number;
      error: string | null;
      scorer_name: string;
      score: number;
      score_reason: string | null;
    }>;

    const caseMap = new Map<string, CaseWithScores>();
    for (const row of rows) {
      let c = caseMap.get(row.id);
      if (!c) {
        c = {
          id: row.id,
          run_id: row.run_id,
          idx: row.idx,
          input: JSON.parse(row.input),
          output: row.output,
          expected: row.expected ? JSON.parse(row.expected) : null,
          latency_ms: row.latency_ms,
          tokens_in: row.tokens_in,
          tokens_out: row.tokens_out,
          error: row.error,
          scores: [],
        };
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
    const totals = this.#stmt(
      `SELECT
        COUNT(DISTINCT c.id) as totalCases,
        COALESCE(SUM(c.latency_ms), 0) as totalLatencyMs,
        COALESCE(SUM(c.tokens_in), 0) as totalTokensIn,
        COALESCE(SUM(c.tokens_out), 0) as totalTokensOut
       FROM cases c WHERE c.run_id = ?`,
    ).get(runId) as {
      totalCases: number;
      totalLatencyMs: number;
      totalTokensIn: number;
      totalTokensOut: number;
    };

    const scorerMeans = this.#stmt(
      `SELECT s.scorer_name, AVG(s.score) as meanScore
       FROM scores s
       JOIN cases c ON c.id = s.case_id
       WHERE c.run_id = ?
       GROUP BY s.scorer_name`,
    ).all(runId) as Array<{ scorer_name: string; meanScore: number }>;

    const meanScores: Record<string, number> = {};
    for (const row of scorerMeans) {
      meanScores[row.scorer_name] = row.meanScore;
    }

    const passFail = this.#stmt(
      `SELECT c.id,
        MIN(s.score) as minScore
       FROM cases c
       JOIN scores s ON s.case_id = c.id
       WHERE c.run_id = ?
       GROUP BY c.id`,
    ).all(runId) as Array<{ id: string; minScore: number }>;

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

  listSuites(): SuiteRow[] {
    const rows = this.#stmt(
      'SELECT * FROM suites ORDER BY created_at DESC',
    ).all() as Array<{ id: string; name: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      created_at: row.created_at,
    }));
  }

  createPrompt(name: string, content: string): PromptRow {
    const id = crypto.randomUUID();
    const now = Date.now();

    const latest = this.#stmt(
      'SELECT MAX(version) as latestVersion FROM prompts WHERE name = ?',
    ).get(name) as { latestVersion: number | null } | undefined;
    const version = (latest?.latestVersion ?? 0) + 1;

    this.#stmt(
      'INSERT INTO prompts (id, name, version, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, version, content, now);
    return { id, name, version, content, created_at: now };
  }

  listPrompts(): PromptRow[] {
    const rows = this.#stmt(
      'SELECT * FROM prompts ORDER BY name COLLATE NOCASE ASC, version DESC',
    ).all() as Array<{
      id: string;
      name: string;
      version: number;
      content: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      content: row.content,
      created_at: row.created_at,
    }));
  }

  getPrompt(id: string): PromptRow | undefined {
    const row = this.#stmt('SELECT * FROM prompts WHERE id = ?').get(id) as
      | {
          id: string;
          name: string;
          version: number;
          content: string;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      content: row.content,
      created_at: row.created_at,
    };
  }

  deletePrompt(id: string): void {
    this.#stmt('DELETE FROM prompts WHERE id = ?').run(id);
  }
}
