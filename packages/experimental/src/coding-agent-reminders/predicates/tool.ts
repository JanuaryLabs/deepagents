import {
  bashCommand,
  matchesName,
  outputText,
  textOf,
  toolCallsOf,
} from '../context.ts';
import type {
  CountSpec,
  HookPredicate,
  ToolCallOptions,
  ToolNameSpec,
} from '../types.ts';
import { assertCountSpec, checkCount } from './count.ts';

export const toolIs =
  (name: string): HookPredicate =>
  (ctx) =>
    ctx.tool_name === name;

export const bashCommandMatches =
  (pattern: RegExp): HookPredicate =>
  (ctx) => {
    pattern.lastIndex = 0;
    return pattern.test(bashCommand(ctx));
  };

export function toolCall(options: ToolCallOptions): HookPredicate {
  return (ctx) => {
    return toolCallsOf(ctx).some((call) => {
      if (options.state && call.state !== options.state) return false;
      if (options.name !== undefined && !matchesName(options.name, call.name)) {
        return false;
      }
      if (options.input && !options.input(call.input)) return false;
      if (options.output) {
        if (call.state !== 'output-available') return false;
        if (!options.output(call.output)) return false;
      }
      if (options.errorText) {
        if (call.state !== 'output-error') return false;
        if (!options.errorText(call.errorText ?? '')) return false;
      }
      return true;
    });
  };
}

export function toolCalled(name: ToolNameSpec): HookPredicate {
  return toolCall({ name });
}

export function toolFailed(name: ToolNameSpec): HookPredicate {
  return toolCall({ name, state: 'output-error' });
}

export function anyToolCalled(): HookPredicate {
  return (ctx) => toolCallsOf(ctx).length > 0;
}

export function toolCallCount(
  name: ToolNameSpec,
  spec: CountSpec,
): HookPredicate {
  assertCountSpec(spec);
  return (ctx) =>
    checkCount(
      toolCallsOf(ctx).filter((call) => matchesName(name, call.name)).length,
      spec,
    );
}

export const outputMatches =
  (pattern: RegExp): HookPredicate =>
  (ctx) => {
    pattern.lastIndex = 0;
    return pattern.test(outputText(ctx));
  };

export const toolOutputMatches = (pattern: RegExp): HookPredicate =>
  toolCall({
    output: (output) => {
      pattern.lastIndex = 0;
      return pattern.test(textOf(output));
    },
  });
