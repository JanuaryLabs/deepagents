/* eslint-disable @nx/enforce-module-boundaries */
import { evalite } from 'evalite';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { InMemoryHistory, Text2Sql } from '@deepagents/text2sql';
import sqlite from '@deepagents/text2sql/sqlite';

import { hint, styleGuide } from '../../lib/teach/teachables.ts';
import { EVAL_MODELS } from '../models';
import { sqlSemanticMatch } from '../scorers';
import { filterByIndex } from '../utils';
import TESTS from './sql-create-context.json' with { type: 'json' };

const DATASET = Array.from(TESTS.rows).map((item) => ({
  question: item.row.question,
  context: item.row.context,
  answer: item.row.answer,
}));


evalite.each(EVAL_MODELS)('SQL Create Context', {
  data: () =>
    filterByIndex(
      DATASET.slice(0, 100).map((item) => ({
        input: {
          question: item.question,
          context: item.context,
        },
        expected: item.answer,
      })),
    ),
  task: async (input, variant) => {
    const db = new DatabaseSync(':memory:');
    db.exec(input.context);

    const text2sql = new Text2Sql({
      version: randomUUID(), // Use unique version per run for cache isolation
      history: new InMemoryHistory(),
      model: variant.model,
      teachingsOptions: { date: false }, // Skip date clarifications for evals
      instructions: [
        hint(
          'For boolean-like or status columns (names containing "is_", "has_", "temporary_", "acting", "active", "enabled", "flag", "status"), infer reasonable filter values from the question context without asking for clarification. Use common conventions: "Yes"/"No", 1/0, "true"/"false", or "Y"/"N". When the question implies a positive state (e.g., "who are acting", "which are active"), use the affirmative value ("Yes", 1, "true").',
        ),
        hint(
          'When the question asks for "average X" across a grouping (e.g., "zip code with average temperature above 60", "lowest average pressure"), you MUST use GROUP BY with AVG(). Do NOT filter individual rows by the raw column value. First GROUP BY the dimension, then filter with HAVING AVG(column) or ORDER BY AVG(column).',
        ),
        hint(
          'For event/status columns, use exact equality (<>, =) not LIKE patterns unless the question explicitly mentions partial matching or "contains". E.g., for "neither Fog nor Rain observed", use EVENTS <> \'Fog\' AND EVENTS <> \'Rain\', not LIKE.',
        ),
        hint(
          'Do NOT add defensive NULL checks unless the question explicitly mentions handling missing/unknown values. Keep queries simple and match the question intent exactly.',
        ),
        hint(
          'Prefer INNER JOIN over LEFT JOIN unless the question explicitly asks for all records including unmatched ones. INNER JOIN is sufficient when the question assumes data integrity.',
        ),
        styleGuide({
          prefer:
            'Use ORDER BY column DESC/ASC LIMIT 1 for single record queries',
          never:
            'Use WHERE column = (SELECT MAX/MIN(column)) - it returns multiple rows on ties',
          always:
            'When question asks for "the" most/least/first/last/latest/recent record, return exactly ONE row using LIMIT 1',
        }),
      ],
      adapter: new sqlite.Sqlite({
        grounding: [sqlite.info(), sqlite.tables(), sqlite.constraints()],
        execute: (sql) => {
          return db.prepare(sql).all();
        },
      }),
    });

    const result = await text2sql.toSql(input.question, {
      enableSampleRows: false,
    });
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
