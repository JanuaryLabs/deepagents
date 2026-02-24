import {
  Factuality as AutoevalsFactuality,
  Levenshtein as AutoevalsLevenshtein,
} from 'autoevals';

export interface ScorerArgs {
  input: unknown;
  output: string;
  expected?: unknown;
}

export interface ScorerResult {
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
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

function normalizeScore(score: number | null | undefined): number {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

function reasonFromMetadata(
  metadata?: Record<string, unknown>,
): string | undefined {
  if (!metadata) return undefined;
  const candidates = [
    metadata.reason,
    metadata.rationale,
    metadata.explanation,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
}

export const levenshtein: Scorer = async ({ output, expected }) => {
  const exp = expected == null ? '' : String(expected);
  const result = await AutoevalsLevenshtein({ output, expected: exp });
  const score = normalizeScore(result.score);
  return {
    score,
    reason: reasonFromMetadata(result.metadata),
    metadata: result.metadata,
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

export function factuality(config: { model: string }): Scorer {
  return async ({ input, output, expected }) => {
    const result = await AutoevalsFactuality({
      model: config.model,
      input: typeof input === 'string' ? input : JSON.stringify(input),
      output,
      expected: expected == null ? undefined : String(expected),
    });
    return {
      score: normalizeScore(result.score),
      reason: reasonFromMetadata(result.metadata),
      metadata: result.metadata,
    };
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
