import type { LanguageModelV3 } from '@ai-sdk/provider';
import { generateObject } from 'ai';
import { z } from 'zod';

export interface ScorerArgs {
  input: unknown;
  output: string;
  expected?: unknown;
}

export interface ScorerResult {
  score: number;
  reason?: string;
}

export type Scorer = (args: ScorerArgs) => Promise<ScorerResult>;

export const exactMatch: Scorer = async ({ output, expected }) => {
  const exp = expected == null ? '' : String(expected);
  if (output === exp) return { score: 1.0 };
  return {
    score: 0.0,
    reason: `Output does not exactly match expected. Expected "${exp}" but got "${output}".`,
  };
};

export const includes: Scorer = async ({ output, expected }) => {
  const exp = expected == null ? '' : String(expected);
  if (output.includes(exp)) return { score: 1.0 };
  return {
    score: 0.0,
    reason: `Output does not include expected substring "${exp}".`,
  };
};

export function regex(pattern: RegExp): Scorer {
  return async ({ output }) => {
    return { score: pattern.test(output) ? 1.0 : 0.0 };
  };
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  if (a.length > b.length) [a, b] = [b, a];

  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  let curr = new Array<number>(a.length + 1);

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(prev[i]! + 1, curr[i - 1]! + 1, prev[i - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[a.length]!;
}

export const levenshtein: Scorer = async ({ output, expected }) => {
  const exp = expected == null ? '' : String(expected);
  if (output.length === 0 && exp.length === 0) return { score: 1.0 };
  const maxLen = Math.max(output.length, exp.length);
  const distance = levenshteinDistance(output, exp);
  const score = Math.max(0, 1 - distance / maxLen);
  if (score === 1.0) return { score };
  return {
    score,
    reason: `Levenshtein distance is ${distance} across max length ${maxLen}.`,
  };
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === 'object') {
    const keysA = Object.keys(a as Record<string, unknown>).sort();
    const keysB = Object.keys(b as Record<string, unknown>).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key, i) =>
        keysB[i] === key &&
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    );
  }

  return false;
}

export const jsonMatch: Scorer = async ({ output, expected }) => {
  try {
    const parsedOutput = JSON.parse(output);
    const parsedExpected =
      typeof expected === 'string' ? JSON.parse(expected) : expected;
    if (deepEqual(parsedOutput, parsedExpected)) return { score: 1.0 };
    return { score: 0.0, reason: 'JSON payload differs from expected JSON.' };
  } catch {
    return { score: 0.0, reason: 'Failed to parse JSON' };
  }
};

const llmScorerSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string(),
});

export function llmJudge(config: {
  model: LanguageModelV3;
  criteria: string;
}): Scorer {
  return async ({ input, output, expected }) => {
    const { object } = await generateObject({
      model: config.model,
      schema: llmScorerSchema,
      prompt: `You are an expert evaluator. Grade the output based on the following criteria:
${config.criteria}

Input: ${JSON.stringify(input)}
Output: ${output}
${expected != null ? `Expected: ${JSON.stringify(expected)}` : ''}

Return a score from 0.0 to 1.0 and a brief reason.`,
    });
    return { score: object.score, reason: object.reason };
  };
}

export function factuality(config: { model: LanguageModelV3 }): Scorer {
  return async ({ input, output, expected }) => {
    const { object } = await generateObject({
      model: config.model,
      schema: llmScorerSchema,
      prompt: `You are a factuality evaluator. Determine whether the output is factually consistent with the expected reference.

Input: ${JSON.stringify(input)}
Output: ${output}
Expected reference: ${JSON.stringify(expected)}

Score 1.0 if the output is factually consistent with the reference, 0.0 if it contradicts it. Use intermediate scores for partial consistency.
Return a score from 0.0 to 1.0 and a brief reason.`,
    });
    return { score: object.score, reason: object.reason };
  };
}

export function all(...scorers: Scorer[]): Scorer {
  return async (args) => {
    if (scorers.length === 0) return { score: 1.0 };
    const results = await Promise.all(scorers.map((s) => s(args)));
    const minResult = results.reduce((min, r) =>
      r.score < min.score ? r : min,
    );
    const reasons = results
      .filter((r) => r.reason)
      .map((r) => r.reason)
      .join('; ');
    return { score: minResult.score, reason: reasons || undefined };
  };
}

export function any(...scorers: Scorer[]): Scorer {
  return async (args) => {
    if (scorers.length === 0) return { score: 0.0 };
    const results = await Promise.all(scorers.map((s) => s(args)));
    const maxResult = results.reduce((max, r) =>
      r.score > max.score ? r : max,
    );
    return { score: maxResult.score, reason: maxResult.reason };
  };
}

export function weighted(
  config: Record<string, { scorer: Scorer; weight: number }>,
): Scorer {
  return async (args) => {
    const entries = Object.entries(config);
    const results = await Promise.all(
      entries.map(async ([name, { scorer, weight }]) => ({
        name,
        result: await scorer(args),
        weight,
      })),
    );
    const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
    const weightedScore = results.reduce(
      (sum, r) => sum + r.result.score * r.weight,
      0,
    );
    const score = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const reasons = results
      .map((r) => `${r.name}: ${r.result.score.toFixed(2)} (w=${r.weight})`)
      .join(', ');
    return { score, reason: reasons || undefined };
  };
}
