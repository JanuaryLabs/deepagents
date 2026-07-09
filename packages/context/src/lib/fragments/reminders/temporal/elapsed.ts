import { type WhenPredicate } from '../src/types.ts';

export function elapsedExceeds(ms: number): WhenPredicate {
  return (ctx) => (ctx.elapsed ?? 0) >= ms;
}
