/* eslint-disable @nx/enforce-module-boundaries */
import { evalite } from 'evalite';
import { DatabaseSync } from 'node:sqlite';

import { InMemoryHistory, Text2Sql } from '@deepagents/text2sql';
import sqlite from '@deepagents/text2sql/sqlite';

import { EVAL_MODELS } from '../models';
import { sqlSemanticMatch } from '../scorers';
import { filterByIndex } from '../utils';
import DATASET from './chinook.json' with { type: 'json' };

const sqliteClient = new DatabaseSync(
  '/Users/ezzabuzaid/Downloads/Chinook.db',
  { readOnly: true },
);

evalite.each(EVAL_MODELS)('Chinook Text2SQL', {
  data: () => filterByIndex(DATASET),
  task: async (question, variant) => {
    const text2sql = new Text2Sql({
      version: `chinook-${variant.model.modelId}`,
      history: new InMemoryHistory(),
      model: variant.model,
      adapter: new sqlite.Sqlite({
        grounding: [sqlite.tables(), sqlite.lowCardinality()],
        execute: (sql) => sqliteClient.prepare(sql).all(),
      }),
    });
    return text2sql.toSql(question, { enableSampleRows: false });
  },
  scorers: [sqlSemanticMatch],
});
