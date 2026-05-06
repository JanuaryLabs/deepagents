import { type WhenPredicate } from '../message/user.ts';

export function usageExceeds(totalTokens: number): WhenPredicate {
  return (ctx) => (ctx.usage?.totalTokens ?? 0) >= totalTokens;
}
