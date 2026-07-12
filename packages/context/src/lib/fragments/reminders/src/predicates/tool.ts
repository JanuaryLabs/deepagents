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
