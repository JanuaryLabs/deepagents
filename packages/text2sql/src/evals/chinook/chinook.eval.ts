/* eslint-disable @nx/enforce-module-boundaries */
import { groq } from '@ai-sdk/groq';
import { evalite } from 'evalite';
import { DatabaseSync } from 'node:sqlite';

import { InMemoryHistory, Text2Sql } from '@deepagents/text2sql';
import sqlite from '@deepagents/text2sql/sqlite';

import { sqlSemanticMatch } from '../scorers';
import QUESTIONS from './chinook.json' with { type: 'json' };

const sqliteClient = new DatabaseSync(
  '/Users/ezzabuzaid/Downloads/Chinook.db',
  { readOnly: true },
);

evalite('Chinook Text2SQL', {
  data: () =>
    QUESTIONS.slice(0, 5).map((q) => ({
      input: q.input,
      expected: q.expected,
    })),
  task: async (question) => {
    const text2sql = new Text2Sql({
      version: 'chinook-eval',
      history: new InMemoryHistory(),
      model: groq('moonshotai/kimi-k2-instruct-0905'),
      adapter: new sqlite.Sqlite({
        grounding: [sqlite.tables(), sqlite.lowCardinality()],
        execute: (sql) => sqliteClient.prepare(sql).all(),
      }),
    });
    return text2sql.toSql(question);
  },
  scorers: [sqlSemanticMatch],
});
