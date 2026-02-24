import { Sql } from 'autoevals';
import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';

import type { Scorer } from '@deepagents/evals';
import {
  RunStore,
  consoleReporter,
  dataset,
  evaluate,
  jsonReporter,
  parseRecordSelection,
} from '@deepagents/evals';
import { toSql } from '@deepagents/text2sql';
import sqlite from '@deepagents/text2sql/sqlite';

import { EVAL_MODELS } from '../models.ts';
import TESTS from './sql-create-context.json' with { type: 'json' };

const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';
const SQL_JUDGE_MODEL =
  process.env['SQL_JUDGE_MODEL'] ?? 'gemini-3-flash-preview';
const geminiApiKey =
  process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];

const openai = new OpenAI({
  apiKey: geminiApiKey ?? 'missing-key',
  baseURL: GEMINI_OPENAI_BASE_URL,
});

const DATASET = Array.from(TESTS.rows).map((item) => ({
  input: {
    question: item.row.question,
    context: item.row.context,
  },
  expected: item.row.answer,
}));

interface CliOptions {
  onlyFailed: boolean;
  rangeSpec?: string;
  help: boolean;
}

function parsePositiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid value "${value}" for ${flag}. Expected integer.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid value "${value}" for ${flag}. Expected >= 1.`);
  }
  return parsed;
}

function parseRange(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.includes(',') ? ',' : '-';
  const parts = trimmed.split(separator).map((part) => part.trim());
  if (parts.length !== 2) {
    throw new Error(
      `Invalid --range value "${value}". Use "start,end" or "start-end".`,
    );
  }
  const start = parsePositiveInt(parts[0]!, '--range');
  const end = parsePositiveInt(parts[1]!, '--range');
  if (end < start) {
    throw new Error(`Invalid --range value "${value}". End must be >= start.`);
  }
  return `${start}-${end}`;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    onlyFailed: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--only-failed') {
      options.onlyFailed = true;
      continue;
    }

    if (arg === '--range') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --range. Example: --range 1,10');
      }
      options.rangeSpec = parseRange(value);
      i++;
      continue;
    }

    if (arg.startsWith('--range=')) {
      options.rangeSpec = parseRange(arg.slice('--range='.length));
      continue;
    }

    throw new Error(
      `Unknown argument "${arg}". Use --help to see supported options.`,
    );
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  node --env-file .env --no-warnings packages/text2sql/src/evals/sql-create-context/sql-create-context.eval.ts [options]

Options:
  --only-failed        Run only failed cases from the latest completed run
  --range START,END    Scope to a 1-based inclusive range, e.g. --range 1,20
  --range START-END    Same as above, e.g. --range 1-20
                       In range mode, first run executes full range; subsequent runs rerun only failed cases for that same range
  --help, -h           Show this help
`);
}

const sqlSemanticMatch: Scorer = async ({ input, output, expected }) => {
  if (!geminiApiKey) {
    throw new Error(
      'Missing Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) to use Gemini as the SQL judge model.',
    );
  }

  const question = (input as Record<string, unknown>).question;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await Sql({
        output,
        expected: String(expected),
        input: String(question),
        useCoT: true,
        client: openai as never,
        model: SQL_JUDGE_MODEL,
      });
      const metadata = (result.metadata ?? {}) as Record<string, unknown>;
      const rationale = metadata['rationale'];
      const reason =
        typeof rationale === 'string'
          ? rationale
          : Array.isArray(rationale)
            ? rationale
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter(Boolean)
                .join(' | ') || undefined
            : undefined;

      return { score: result.score ?? 0, reason, metadata };
    } catch (error) {
      if (attempt === maxAttempts) {
        console.warn(
          `sqlSemanticMatch failed after ${maxAttempts} attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { score: 0 };
      }
    }
  }

  return { score: 0 };
};

const cli = parseCliArgs(process.argv.slice(2));
if (cli.help) {
  printHelp();
  process.exit(0);
}

const rangeSelection = cli.rangeSpec
  ? parseRecordSelection(cli.rangeSpec)
  : undefined;
const suiteName = rangeSelection
  ? `SQL Create Context [range ${cli.rangeSpec}]`
  : 'SQL Create Context';
const evalDataset = rangeSelection
  ? dataset(DATASET).pick(rangeSelection.indexes)
  : dataset(DATASET);

const run = evaluate({
  name: suiteName,
  models: EVAL_MODELS.map((m) => ({ name: m.name, model: m.input.model })),
  dataset: evalDataset,
  task: async (item, variant) => {
    const db = new DatabaseSync(':memory:');
    db.exec(item.input.context);

    const adapter = new sqlite.Sqlite({
      grounding: [sqlite.info(), sqlite.tables(), sqlite.constraints()],
      execute: (sql) => db.prepare(sql).all(),
    });

    try {
      const fragments = await adapter.introspect();

      const result = await toSql({
        input: item.input.question,
        adapter,
        fragments,
        model: variant.model,
      });

      return { output: result.sql };
    } finally {
      db.close();
    }
  },
  scorers: { sql: sqlSemanticMatch },
  reporters: [consoleReporter(), jsonReporter()],
  maxConcurrency: 5,
  store: new RunStore('.evals/store.sqlite'),
});

// Default behavior is failed-only to support iterative debugging loops.
// In range mode this reruns only failed records within that range after the first run.
await run.failed();
