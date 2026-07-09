import type { WhenPredicate } from '../types.ts';

export function usageExceeds(totalTokens: number): WhenPredicate {
  return (ctx) => (ctx.usage?.totalTokens ?? 0) >= totalTokens;
}
