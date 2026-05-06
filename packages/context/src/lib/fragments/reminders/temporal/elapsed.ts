import { type WhenPredicate } from '../../message/user.ts';

export function elapsedExceeds(ms: number): WhenPredicate {
  return (ctx) => (ctx.elapsed ?? 0) >= ms;
}
