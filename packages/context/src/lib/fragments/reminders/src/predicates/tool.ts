import { type ToolUIPart, type UIMessage, isStaticToolUIPart } from 'ai';

import type { CountSpec, ToolOutcome, WhenPredicate } from '../types.ts';
import { assertCountSpec, checkCount } from './message.ts';

export type ToolNameSpec = string | ((name: string) => boolean);

export interface ToolCallOptions {
  name?: ToolNameSpec;
  state?: ToolUIPart['state'];
  input?: (input: unknown) => boolean;
  output?: (output: unknown) => boolean;
  errorText?: (text: string) => boolean;
}

export interface ToolOutputOptions {
  name?: ToolNameSpec;
  state?: ToolOutcome['state'];
  input?: (input: unknown) => boolean;
  output?: (output: unknown) => boolean;
  error?: (error: unknown) => boolean;
  errorText?: (text: string) => boolean;
  reason?: (reason: string | undefined) => boolean;
}

const COMPLETED_STATES: ReadonlySet<ToolUIPart['state']> = new Set([
  'input-available',
  'output-available',
  'output-error',
]);

function matchesName(spec: ToolNameSpec, name: string): boolean {
  return typeof spec === 'function' ? spec(name) : spec === name;
}

function toolNameOf(part: ToolUIPart): string {
  return part.type.slice('tool-'.length);
}

function toolPartsOf(message: UIMessage | undefined): ToolUIPart[] {
  if (!message) return [];
  return message.parts.filter(isStaticToolUIPart);
}

export function toolCall(options: ToolCallOptions): WhenPredicate {
  return (ctx) => {
    const parts = toolPartsOf(ctx.lastAssistantMessage);
    return parts.some((part) => {
      if (options.state) {
        if (part.state !== options.state) return false;
      } else if (!COMPLETED_STATES.has(part.state)) {
        return false;
      }
      if (
        options.name !== undefined &&
        !matchesName(options.name, toolNameOf(part))
      ) {
        return false;
      }
      if (
        options.input &&
        !options.input((part as { input?: unknown }).input)
      ) {
        return false;
      }
      if (options.output) {
        if (part.state !== 'output-available') return false;
        if (!options.output((part as { output?: unknown }).output))
          return false;
      }
      if (options.errorText) {
        if (part.state !== 'output-error') return false;
        const text = (part as { errorText?: string }).errorText ?? '';
        if (!options.errorText(text)) return false;
      }
      return true;
    });
  };
}

/** Match the terminal tool outcome currently being evaluated. */
export function toolOutput(options: ToolOutputOptions = {}): WhenPredicate {
  return (ctx) => {
    const outcome = ctx.toolOutcome;
    if (!outcome) return false;
    if (options.state !== undefined && outcome.state !== options.state) {
      return false;
    }
    if (
      options.name !== undefined &&
      !matchesName(options.name, outcome.name)
    ) {
      return false;
    }
    if (options.input && !options.input(outcome.input)) return false;
    if (options.output) {
      if (outcome.state !== 'output-available') return false;
      if (!options.output(outcome.output)) return false;
    }
    if (options.error) {
      if (outcome.state !== 'output-error') return false;
      if (!options.error(outcome.error)) return false;
    }
    if (options.errorText) {
      if (outcome.state !== 'output-error') return false;
      if (!options.errorText(outcome.errorText)) return false;
    }
    if (options.reason) {
      if (outcome.state !== 'output-denied') return false;
      if (!options.reason(outcome.reason)) return false;
    }
    return true;
  };
}

export function toolCalled(name: ToolNameSpec): WhenPredicate {
  return toolCall({ name });
}

export function toolFailed(name: ToolNameSpec): WhenPredicate {
  return toolCall({ name, state: 'output-error' });
}

export function anyToolCalled(): WhenPredicate {
  return (ctx) =>
    toolPartsOf(ctx.lastAssistantMessage).some((part) =>
      COMPLETED_STATES.has(part.state),
    );
}

export function toolCallCount(
  name: ToolNameSpec,
  spec: CountSpec,
): WhenPredicate {
  assertCountSpec(spec);
  return (ctx) => {
    const count = toolPartsOf(ctx.lastAssistantMessage).filter(
      (part) =>
        COMPLETED_STATES.has(part.state) && matchesName(name, toolNameOf(part)),
    ).length;
    return checkCount(count, spec);
  };
}

/**
 * Match after `n` terminal tool outcomes in the current assistant segment.
 *
 * Steer and tool-output reminders carve the assistant reply when they fire, so
 * the segment count restarts before delivery. The predicate itself is
 * stateless: identical context produces an identical result.
 */
export function everyNToolCalls(n: number): WhenPredicate {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('everyNToolCalls(n) requires a positive integer');
  }

  return (ctx) =>
    toolPartsOf(ctx.lastAssistantMessage).filter((part) =>
      ['output-available', 'output-error', 'output-denied'].includes(
        part.state,
      ),
    ).length >= n;
}

/**
 * How many times `name` has failed in a row, counting back from the newest
 * result. A success ends the run.
 *
 * Reads `lastAssistantMessages` (every assistant segment), NOT
 * `lastAssistantMessage`: a firing reminder carves the assistant message at its
 * boundary, so the single current message only holds the parts since the last
 * fire and a streak read from it would reset to 1 on every fire.
 */
export function toolFailureStreak(
  ctx: { lastAssistantMessages?: UIMessage[] },
  name: ToolNameSpec,
): number {
  const parts = (ctx.lastAssistantMessages ?? []).flatMap((message) =>
    toolPartsOf(message).filter((part) => matchesName(name, toolNameOf(part))),
  );
  let streak = 0;
  for (const part of parts.toReversed()) {
    if (part.state !== 'output-error') break;
    streak++;
  }
  return streak;
}

/** Gate on a run of consecutive failures, e.g. `toolFailedStreak('bash', { gte: 3 })`. */
export function toolFailedStreak(
  name: ToolNameSpec,
  spec: CountSpec,
): WhenPredicate {
  assertCountSpec(spec);
  return (ctx) => checkCount(toolFailureStreak(ctx, name), spec);
}
