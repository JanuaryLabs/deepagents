import type { WhenPredicate } from '../message/user.ts';

export function everyNTurns(n: number): WhenPredicate {
  return ({ turn }) => turn % n === 0;
}

export function once(): WhenPredicate {
  return ({ turn }) => turn === 1;
}

export function firstN(n: number): WhenPredicate {
  return ({ turn }) => turn <= n;
}

export function afterTurn(n: number): WhenPredicate {
  return ({ turn }) => turn > n;
}
