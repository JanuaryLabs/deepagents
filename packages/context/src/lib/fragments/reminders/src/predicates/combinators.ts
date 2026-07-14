import type { UIMessage } from 'ai';

import type { WhenContext, WhenPredicate } from '../types.ts';

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
 * The window both combinators count over: assistant REPLIES, not the segments a
 * firing reminder carved them into.
 *
 * A reply is everything the assistant produced in answer to one real user
 * message, with its segments merged back. Counting segments instead would make
 * `n` depend on unrelated reminder activity — registering one tool-output
 * reminder turns a single reply into several stored assistant messages, which
 * would silently shrink the threshold.
 */
function replyWindow(ctx: WhenContext): UIMessage[] {
  return ctx.lastAssistantReplies ?? [];
}

/**
 * Existential window: fires when `predicate` matches AT LEAST ONE of the last
 * N assistant replies.
 *
 * Rebinds ONLY `lastAssistantMessage`, to the merged reply. Wrapping predicates
 * that read other fields (currentMessage, content, turn, usage, elapsed) is a
 * no-op — those stay frozen at the outer ctx values. Intended for tool
 * predicates and `lastAssistantLength`.
 *
 * Short-circuits on first match. Returns false when no chain history.
 */
export function withinLastN(
  n: number,
  predicate: WhenPredicate,
): AsyncWhenPredicate {
  return async (ctx) => {
    if (n <= 0) return false;
    for (const reply of replyWindow(ctx).slice(-n)) {
      if (await predicate({ ...ctx, lastAssistantMessage: reply })) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Universal window: fires only when `predicate` matches EVERY ONE of the last
 * N assistant replies. Use for streak detection (e.g. "no tool use in any of
 * the last 3 replies").
 *
 * Rebinds ONLY `lastAssistantMessage`, same scope rules as `withinLastN`.
 *
 * Short-circuits on first non-match. Returns false when fewer than N replies
 * exist — a streak of N requires at least N candidates.
 */
export function everyOfLastN(
  n: number,
  predicate: WhenPredicate,
): AsyncWhenPredicate {
  return async (ctx) => {
    if (n <= 0) return false;
    const replies = replyWindow(ctx);
    if (replies.length < n) return false;
    for (const reply of replies.slice(-n)) {
      if (!(await predicate({ ...ctx, lastAssistantMessage: reply }))) {
        return false;
      }
    }
    return true;
  };
}
