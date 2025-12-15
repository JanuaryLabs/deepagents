/* eslint-disable @nx/enforce-module-boundaries */
import { evalite } from 'evalite';
import { DatabaseSync } from 'node:sqlite';

import sqlite from '@deepagents/text2sql/sqlite';

import { TeachingsGenerator } from '../../lib/synthesis/synthesizers/teachings-generator.ts';
import { toInstructions } from '../../lib/teach/teachables.ts';
import { teachingsCoverage, teachingsQuality } from '../scorers';
import { filterByIndex } from '../utils';
import DATASET from './teachings-dataset.json' with { type: 'json' };

interface TeachingsEvalCase {
  id: string;
  schema: string;
  expected: {
    glossary_terms?: string[];
    hints?: string[];
    guardrails?: string[];
  };
}

const typedDataset = DATASET as TeachingsEvalCase[];

evalite('TeachingsGenerator Quality', {
  data: () =>
    filterByIndex(
      typedDataset.map((item) => ({
        input: {
          schema: item.schema,
        },
        expected: item.expected,
      })),
    ),
  task: async (input) => {
    // Create in-memory SQLite database with the schema
    const db = new DatabaseSync(':memory:');
    db.exec(input.schema);

    // Create adapter
    const adapter = new sqlite.Sqlite({
      grounding: [sqlite.info(), sqlite.tables()],
      execute: (sql) => db.prepare(sql).all(),
    });

    // Generate teachings using TeachingsGenerator
    const generator = new TeachingsGenerator(adapter);
    const teachings = await generator.generate();

    db.close();

    // Convert teachings to string representation for scoring
    const teachingsText = toInstructions('teachings', ...teachings);

    return teachingsText;
  },
  scorers: [teachingsQuality, teachingsCoverage],
  columns(opts) {
    const qualityScore = opts.scores.find((s) => s.name === 'TeachingsQuality');
    const coverageScore = opts.scores.find(
      (s) => s.name === 'TeachingsCoverage',
    );
    const qualityMeta = qualityScore?.metadata as {
      rationale?: string;
      choice?: string;
    };
    const coverageMeta = coverageScore?.metadata as {
      covered?: number;
      total?: number;
      details?: Record<string, boolean>;
    };

    return [
      {
        label: 'Schema',
        value: opts.input.schema,
      },
      {
        label: 'Expected',
        value: JSON.stringify(opts.expected, null, 2),
      },
      {
        label: 'Quality',
        value: `${qualityScore?.score?.toFixed(2)} (${qualityMeta?.choice})`,
      },
      {
        label: 'Coverage',
        value: `${coverageScore?.score?.toFixed(2)} (${coverageMeta?.covered}/${coverageMeta?.total})`,
      },
      {
        label: 'Details',
        value: JSON.stringify(coverageMeta?.details, null, 2),
      },
    ];
  },
});
