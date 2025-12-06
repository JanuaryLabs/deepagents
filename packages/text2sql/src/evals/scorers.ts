import { Levenshtein, Sql } from 'autoevals';
import { createScorer } from 'evalite';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY'],
});

/**
 * SQL Semantic Match scorer using LLM-as-a-judge
 * Compares if two SQL queries are semantically equivalent
 */
export const sqlSemanticMatch = createScorer<unknown, string, string>({
  name: 'SQLSemanticMatch',
  description: 'Evaluates semantic equivalence of SQL queries using LLM judge',
  scorer: async ({ output, expected, input }) => {
    const result = await Sql({
      output: output,
      useCoT: true,
      expected: expected,
      input: typeof input === 'string' ? input : JSON.stringify(input),
      client: openai as never,
      model: 'gpt-4.1-nano',
    });

    return {
      score: result.score ?? 0,
      metadata: result.metadata,
    };
  },
});

/**
 * String similarity scorer using Levenshtein distance
 */
export const stringSimilarity = createScorer<unknown, string, string>({
  name: 'String Similarity',
  description: 'Measures string similarity using Levenshtein distance',
  scorer: async ({ output, expected }) => {
    const result = await Levenshtein({
      output: String(output),
      expected: String(expected),
    });
    return {
      score: result.score ?? 0,
      metadata: {
        expected: String(expected),
        output: String(output),
      },
    };
  },
});
