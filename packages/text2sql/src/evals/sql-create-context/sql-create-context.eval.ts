/* eslint-disable @nx/enforce-module-boundaries */
import { evalite } from 'evalite';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { cerebras } from '@deepagents/agent';
import { InMemoryHistory, Text2Sql } from '@deepagents/text2sql';
import sqlite from '@deepagents/text2sql/sqlite';

import { sqlSemanticMatch } from '../scorers';
import TESTS from './sql-create-context.json' with { type: 'json' };

const model = cerebras('gpt-oss-120b');

interface DataSet {
  question: string;
  context: string;
  answer: string;
}

const DATASET = TESTS as DataSet[];

// URL: https://huggingface.co/datasets/b-mc2/sql-create-context/resolve/main/sql_create_context_v4.json

evalite('SQL Create Context', {
  data: () =>
    DATASET.slice(0, 15).map((item) => ({
      input: {
        question: item.question,
        context: item.context,
      },
      expected: item.answer,
    })),
  task: async (input) => {
    const db = new DatabaseSync(':memory:');
    db.exec(input.context);

    const text2sql = new Text2Sql({
      version: randomUUID(), // Use unique version per run for cache isolation
      history: new InMemoryHistory(),
      model: model,
      adapter: new sqlite.Sqlite({
        grounding: [sqlite.info(), sqlite.tables()],
        execute: (sql) => {
          return db.prepare(sql).all();
        },
      }),
    });

    const result = await text2sql.toSql(input.question);
    db.close();
    return result;
  },
  scorers: [sqlSemanticMatch],
  columns(opts) {
    const sqlSemanticMatch = opts.scores.find(
      (s) => s.name === 'SQLSemanticMatch',
    );

    return [
      {
        label: 'Context',
        value: opts.input.context,
      },
      {
        label: 'Question',
        value: opts.input.question,
      },
      {
        label: 'Expected Answer',
        value: opts.expected,
      },
      {
        label: 'Generated SQL',
        value: opts.output,
      },
      {
        label: 'Score',
        value: sqlSemanticMatch?.score,
      },
      {
        label: 'Rationale',
        value:
          (sqlSemanticMatch?.metadata as { rationale?: string })?.rationale ??
          '',
      },
    ];
  },
});
