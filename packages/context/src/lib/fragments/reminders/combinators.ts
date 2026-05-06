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

/**
 * Existential window: fires when `predicate` matches AT LEAST ONE of the last
 * N assistant messages.
 *
 * Rebinds ONLY `lastAssistantMessage`. Wrapping predicates that read other
 * fields (currentMessage, content, turn, usage, elapsed) is a no-op — those
 * stay frozen at the outer ctx values. Intended for tool predicates and
 * `lastAssistantLength`.
 *
 * Short-circuits on first match. Returns false when no chain history.
 */
export function withinLastN(
  n: number,
  predicate: WhenPredicate,
): AsyncWhenPredicate {
  return async (ctx) => {
    if (n <= 0) return false;
    const candidates = (ctx.lastAssistantMessages ?? []).slice(-n);
    for (const message of candidates) {
      if (await predicate({ ...ctx, lastAssistantMessage: message })) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Universal window: fires only when `predicate` matches EVERY ONE of the last
 * N assistant messages. Use for streak detection (e.g. "no tool use in any of
 * the last 3 replies").
 *
 * Rebinds ONLY `lastAssistantMessage`, same scope rules as `withinLastN`.
 *
 * Short-circuits on first non-match. Returns false when fewer than N
 * assistant messages exist — a streak of N requires at least N candidates.
 */
export function everyOfLastN(
  n: number,
  predicate: WhenPredicate,
): AsyncWhenPredicate {
  return async (ctx) => {
    if (n <= 0) return false;
    const history = ctx.lastAssistantMessages ?? [];
    if (history.length < n) return false;
    const candidates = history.slice(-n);
    for (const message of candidates) {
      if (!(await predicate({ ...ctx, lastAssistantMessage: message }))) {
        return false;
      }
    }
    return true;
  };
}
