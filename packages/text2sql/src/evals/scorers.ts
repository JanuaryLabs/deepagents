import { Factuality, Levenshtein, Sql } from 'autoevals';
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
    const metadata = (result.metadata ?? {}) as Record<string, unknown>;
    const rationale = metadata['rationale'];
    const reason =
      typeof rationale === 'string'
        ? rationale
        : Array.isArray(rationale)
          ? rationale
              .map((item) => (typeof item === 'string' ? item.trim() : ''))
              .filter(Boolean)
              .join(' | ') || undefined
          : undefined;

    return {
      score: result.score ?? 0,
      reason,
      metadata,
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

interface TeachingsExpected {
  glossary_terms?: string[];
  hints?: string[];
  guardrails?: string[];
}

interface TeachingsInput {
  schema: string;
}

/**
 * Teachings Quality scorer using Factuality from autoevals
 * Evaluates if generated teachings are factual compared to expected
 */
export const teachingsQuality = createScorer<
  TeachingsInput,
  string,
  TeachingsExpected
>({
  name: 'TeachingsQuality',
  description:
    'Evaluates teachings quality using Factuality scorer from autoevals',
  scorer: async ({ output, expected, input }) => {
    const result = await Factuality({
      output: output,
      expected: JSON.stringify(expected),
      input: `Database schema:\n${input.schema}`,
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
 * Teachings Coverage scorer - checks if expected concepts appear in output
 * More lenient than Factuality - uses keyword matching + LLM verification
 */
export const teachingsCoverage = createScorer<
  TeachingsInput,
  string,
  TeachingsExpected
>({
  name: 'TeachingsCoverage',
  description: 'Evaluates coverage of expected teachings in generated output',
  scorer: async ({ output, expected }) => {
    const outputLower = output.toLowerCase();
    let covered = 0;
    let total = 0;
    const details: Record<string, boolean> = {};

    // Check glossary terms
    for (const term of expected.glossary_terms ?? []) {
      total++;
      const termLower = term.toLowerCase();
      // Check if term or its parts appear in output
      const found =
        outputLower.includes(termLower) ||
        termLower.split(' ').every((word) => outputLower.includes(word));
      if (found) covered++;
      details[`glossary:${term}`] = found;
    }

    // Check hints
    for (const hint of expected.hints ?? []) {
      total++;
      const hintLower = hint.toLowerCase();
      // Check key words from hint
      const keywords = hintLower.split(' ').filter((w) => w.length > 3);
      const found = keywords.some((kw) => outputLower.includes(kw));
      if (found) covered++;
      details[`hint:${hint}`] = found;
    }

    // Check guardrails
    for (const guardrail of expected.guardrails ?? []) {
      total++;
      const guardrailLower = guardrail.toLowerCase();
      const keywords = guardrailLower.split(' ').filter((w) => w.length > 3);
      const found = keywords.some((kw) => outputLower.includes(kw));
      if (found) covered++;
      details[`guardrail:${guardrail}`] = found;
    }

    const score = total > 0 ? covered / total : 1;

    return {
      score,
      metadata: {
        covered,
        total,
        details,
      },
    };
  },
});
