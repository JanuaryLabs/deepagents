import type { CountSpec } from '../types.ts';

export function assertCountSpec(spec: CountSpec): void {
  const hasEq = spec.eq !== undefined;
  const hasRange = spec.gte !== undefined || spec.lte !== undefined;
  if (!hasEq && !hasRange) {
    throw new Error('CountSpec must include at least one of gte/lte/eq');
  }
  if (hasEq && hasRange) {
    throw new Error('CountSpec.eq cannot be combined with gte/lte');
  }
}

export function checkCount(count: number, spec: CountSpec): boolean {
  if (spec.eq !== undefined) return count === spec.eq;
  if (spec.gte !== undefined && count < spec.gte) return false;
  if (spec.lte !== undefined && count > spec.lte) return false;
  return true;
}
