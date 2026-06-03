import { groq } from '@ai-sdk/groq';
import { evalite } from 'evalite';
import { DatabaseSync } from 'node:sqlite';

import { parseRecordSelection, pickFromArray } from '@deepagents/evals';
import { Text2Sql } from '@deepagents/text2sql';
import sqlite from '@deepagents/text2sql/sqlite';

import TESTS from './formatting.json' with { type: 'json' };

const { indexes } = parseRecordSelection('2');

evalite('SQL Output Formatting', {
  data: () =>
    pickFromArray(
      TESTS.map((it) => ({
        input: { question: it.input, ddl: it.ddl },
        expected: it.expected,
      })),
      indexes,
    ),
  task: async ({ question, ddl }) => {
    const db = new DatabaseSync(':memory:');
    db.exec(ddl);

    const adapter = new sqlite.Sqlite({
      grounding: [sqlite.info(), sqlite.tables()],
      execute: (sql) => db.prepare(sql).all(),
    });
    const text2sql = new Text2Sql({
      adapters: { main: adapter },
      model: groq('gpt-oss-20b'),
    });

    const result = await text2sql.toSql(question, 'main');
    db.close();
    return result;
  },
  scorers: [
    {
      name: 'No Markdown',
      description: 'Output should not contain markdown code blocks',
      scorer: ({ output }) => {
        const hasMarkdown = /```/.test(String(output));
        return {
          score: hasMarkdown ? 0 : 1,
          metadata: {
            rationale: hasMarkdown
              ? `Found markdown code blocks in output: "${String(output).slice(0, 100)}..."`
              : 'Output is clean SQL without markdown',
          },
        };
      },
    },
    {
      name: 'Starts with SQL',
      description:
        'Output should start with SELECT, WITH, INSERT, UPDATE, DELETE, or CREATE',
      scorer: ({ output }) => {
        const sqlKeywords = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE)/i;
        const startsWithSql = sqlKeywords.test(String(output));
        const match = String(output).match(/^\s*(\w+)/);
        return {
          score: startsWithSql ? 1 : 0,
          metadata: {
            rationale: startsWithSql
              ? `Output correctly starts with SQL keyword`
              : `Output starts with "${match?.[1] ?? 'unknown'}" instead of a SQL keyword`,
            firstWord: match?.[1] ?? 'empty',
          },
        };
      },
    },
    {
      name: 'No Natural Language',
      description: 'Output should not contain common preamble phrases',
      scorer: ({ output }) => {
        const preambles = [
          /here is/i,
          /here's/i,
          /the query/i,
          /this query/i,
          /i found/i,
          /total of/i,
          /there are/i,
          /results:/i,
        ];
        const matchedPreamble = preambles.find((p) => p.test(String(output)));
        const hasNaturalLanguage = !!matchedPreamble;
        return {
          score: hasNaturalLanguage ? 0 : 1,
          metadata: {
            rationale: hasNaturalLanguage
              ? `Found natural language preamble matching: ${matchedPreamble}`
              : 'Output contains only SQL without natural language',
          },
        };
      },
    },
  ],
});
