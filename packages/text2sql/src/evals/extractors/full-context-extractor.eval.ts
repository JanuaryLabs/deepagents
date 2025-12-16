/* eslint-disable @nx/enforce-module-boundaries */
import { evalite } from 'evalite';
import { DatabaseSync } from 'node:sqlite';

import sqlite from '@deepagents/text2sql/sqlite';
import { FullContextExtractor } from '@deepagents/text2sql/synthesis';

import { simulateConversation } from '../helpers/conversation-simulator';
import { filterByIndex } from '../utils';

const DB_PATH = '/Users/ezzabuzaid/Downloads/Chinook.db';

// Check if DB exists, skip test if not
let sqliteClient: DatabaseSync;
try {
  sqliteClient = new DatabaseSync(DB_PATH, { readOnly: true });
} catch {
  console.warn(`Database not found at ${DB_PATH}, skipping eval`);
  process.exit(0);
}

const adapter = new sqlite.Sqlite({
  grounding: [sqlite.tables(), sqlite.columnValues()],
  execute: (sql) => sqliteClient.prepare(sql).all(),
});

interface EvalInput {
  initialQuestion: string;
  turns: number;
  description: string;
}

evalite<EvalInput, string>('FullContextExtractor - Question Resolution', {
  data: () =>
    filterByIndex([
      {
        input: {
          initialQuestion: 'Show me all customers',
          turns: 3,
          description: 'Customer exploration with follow-ups',
        },
      },
      {
        input: {
          initialQuestion: 'What were total sales last year?',
          turns: 2,
          description: 'Sales analysis with refinement',
        },
      },
      {
        input: {
          initialQuestion: 'List the top 5 artists by number of albums',
          turns: 2,
          description: 'Artist ranking with drill-down',
        },
      },
    ]),

  task: async (input) => {
    // 1. Simulate multi-turn conversation
    const { messages, questions } = await simulateConversation({
      adapter,
      initialQuestion: input.initialQuestion,
      turns: input.turns,
    });

    // 2. Extract pairs using FullContextExtractor
    const extractor = new FullContextExtractor(messages, adapter);
    const pairs = await extractor.toPairs();

    // 3. Return results for scoring
    if (pairs.length === 0) {
      return JSON.stringify({
        success: false,
        error: 'No pairs extracted',
        questionsAsked: questions,
        messageCount: messages.length,
      });
    }

    return JSON.stringify({
      success: true,
      pairsExtracted: pairs.length,
      questionsAsked: questions,
      resolvedQuestions: pairs.map((p) => ({
        question: p.question,
        sql: p.sql.slice(0, 100) + (p.sql.length > 100 ? '...' : ''),
        contextLength: p.context?.length ?? 0,
      })),
    });
  },

  scorers: [
    {
      name: 'ExtractionSuccess',
      description: 'Did the extractor produce any pairs?',
      scorer: async ({ output }) => {
        try {
          const result = JSON.parse(output);
          return { score: result.success ? 1 : 0 };
        } catch {
          return { score: 0 };
        }
      },
    },
    {
      name: 'StandaloneQuestions',
      description:
        'Are the resolved questions standalone (no dangling pronouns)?',
      scorer: async ({ output }) => {
        try {
          const result = JSON.parse(output);
          if (!result.success || !result.resolvedQuestions) {
            return { score: 0 };
          }

          // Check for dangling pronouns that suggest incomplete resolution
          const danglingPatterns =
            /\b(it|that|those|these|the same|them|they)\b(?!\s+(is|was|are|were|will|would|should|could|can|may|might|has|have|had))/gi;

          let goodQuestions = 0;
          for (const pair of result.resolvedQuestions) {
            const matches = pair.question.match(danglingPatterns) || [];
            if (matches.length === 0) {
              goodQuestions++;
            }
          }

          return {
            score: goodQuestions / result.resolvedQuestions.length,
          };
        } catch {
          return { score: 0 };
        }
      },
    },
    {
      name: 'ContextAccumulation',
      description: 'Does context grow with each turn?',
      scorer: async ({ output }) => {
        try {
          const result = JSON.parse(output);
          if (!result.success || !result.resolvedQuestions) {
            return { score: 0 };
          }

          // Check if context lengths are non-decreasing
          const lengths = result.resolvedQuestions.map(
            (p: { contextLength: number }) => p.contextLength,
          );

          let increasing = 0;
          for (let i = 1; i < lengths.length; i++) {
            if (lengths[i] >= lengths[i - 1]) {
              increasing++;
            }
          }

          if (lengths.length <= 1) return { score: 1 };
          return { score: increasing / (lengths.length - 1) };
        } catch {
          return { score: 0 };
        }
      },
    },
    {
      name: 'SQLPresent',
      description: 'Do all extracted pairs have SQL?',
      scorer: async ({ output }) => {
        try {
          const result = JSON.parse(output);
          if (!result.success || !result.resolvedQuestions) {
            return { score: 0 };
          }

          const withSQL = result.resolvedQuestions.filter(
            (p: { sql: string }) => p.sql && p.sql.length > 0,
          ).length;

          return { score: withSQL / result.resolvedQuestions.length };
        } catch {
          return { score: 0 };
        }
      },
    },
  ],
});
