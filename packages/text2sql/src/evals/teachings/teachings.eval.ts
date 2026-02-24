/* eslint-disable @nx/enforce-module-boundaries */
import { evalite } from 'evalite';
import { DatabaseSync } from 'node:sqlite';

import { XmlRenderer } from '@deepagents/context';
import { parseRecordSelection, pickFromArray } from '@deepagents/evals';
import sqlite from '@deepagents/text2sql/sqlite';

import { generateTeachings } from '../../lib/synthesis/synthesizers/teachings-generator.ts';
import { teachingsCoverage, teachingsQuality } from '../scorers';
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

const { indexes } = parseRecordSelection('2');

evalite('TeachingsGenerator Quality', {
  data: () =>
    pickFromArray(
      typedDataset.map((item) => ({
        input: {
          schema: item.schema,
        },
        expected: item.expected,
      })),
      indexes,
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

    // Generate teachings
    const schemaFragments = await adapter.introspect();
    const teachings = await generateTeachings(schemaFragments);

    db.close();

    return new XmlRenderer().render(teachings);
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
