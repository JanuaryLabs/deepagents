import type { WhenPredicate } from '../types.ts';

export function everyNTurns(n: number): WhenPredicate {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('everyNTurns(n) requires a positive integer');
  }
  return ({ turn }) => turn % n === 0;
}

export function first(): WhenPredicate {
  return ({ turn }) => turn === 1;
}

export function firstN(n: number): WhenPredicate {
  return ({ turn }) => turn <= n;
}

export function afterTurn(n: number): WhenPredicate {
  return ({ turn }) => turn > n;
}
