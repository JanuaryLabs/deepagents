/* eslint-disable @nx/enforce-module-boundaries */
import { Sql } from 'autoevals';
import { DatabaseSync } from 'node:sqlite';
import OpenAI from 'openai';

import type { Scorer } from '@deepagents/evals';
import {
  consoleReporter,
  dataset,
  evaluate,
  jsonReporter,
} from '@deepagents/evals';
import { toSql } from '@deepagents/text2sql';
import sqlite from '@deepagents/text2sql/sqlite';

import { EVAL_MODELS } from '../models.ts';
import DATASET from './chinook.json' with { type: 'json' };

const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
});

const sqliteClient = new DatabaseSync(
  '/Users/ezzabuzaid/Downloads/Chinook_Sqlite.sqlite',
  { readOnly: true },
);

const adapter = new sqlite.Sqlite({
  grounding: [sqlite.tables(), sqlite.columnValues()],
  execute: (sql) => sqliteClient.prepare(sql).all(),
});

const schemaFragments = await adapter.introspect();

const sqlSemanticMatch: Scorer = async ({ input, output, expected }) => {
  const question = (input as Record<string, unknown>).input;
  const result = await Sql({
    output,
    expected: String(expected),
    input: String(question),
    useCoT: true,
    client: openai as never,
    model: 'gpt-4.1-nano',
  });
  return { score: result.score ?? 0 };
};

await evaluate({
  name: 'Chinook Text2SQL',
  models: EVAL_MODELS.map((m) => ({ name: m.name, model: m.input.model })),
  dataset: dataset(DATASET as Array<{ input: string; expected: string }>).limit(
    1,
  ),
  task: async (item, variant) => {
    const result = await toSql({
      input: item.input,
      adapter,
      fragments: schemaFragments,
      model: variant.model,
    });
    return { output: result.sql };
  },
  scorers: { sql: sqlSemanticMatch },
  reporters: [consoleReporter(), jsonReporter()],
  maxConcurrency: 1,
});
