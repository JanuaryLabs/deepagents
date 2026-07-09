import type { AsyncHookPredicate, HookPredicate } from '../types.ts';

export const always: HookPredicate = () => true;

export const and =
  (...predicates: HookPredicate[]): AsyncHookPredicate =>
  async (ctx) => {
    for (const predicate of predicates) {
      if (!(await predicate(ctx))) return false;
    }
    return true;
  };

export const or =
  (...predicates: HookPredicate[]): AsyncHookPredicate =>
  async (ctx) => {
    for (const predicate of predicates) {
      if (await predicate(ctx)) return true;
    }
    return false;
  };

export const not =
  (predicate: HookPredicate): AsyncHookPredicate =>
  async (ctx) =>
    !(await predicate(ctx));
