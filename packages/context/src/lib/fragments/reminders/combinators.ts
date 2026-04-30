import type { WhenContext, WhenPredicate } from '../message/user.ts';

export type AsyncWhenPredicate = (ctx: WhenContext) => Promise<boolean>;

export function and(...predicates: WhenPredicate[]): AsyncWhenPredicate {
  return async (ctx) => {
    for (const it of predicates) {
      if (!(await it(ctx))) return false;
    }
    return true;
  };
}

export function or(...predicates: WhenPredicate[]): AsyncWhenPredicate {
  return async (ctx) => {
    for (const it of predicates) {
      if (await it(ctx)) return true;
    }
    return false;
  };
}

export function not(predicate: WhenPredicate): AsyncWhenPredicate {
  return async (ctx) => !(await predicate(ctx));
}
