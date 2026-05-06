import { type ToolUIPart, type UIMessage, isStaticToolUIPart } from 'ai';

import { type WhenPredicate } from '../message/user.ts';
import {
  type CountSpec,
  assertCountSpec,
  checkCount,
} from './message-predicates.ts';

export type ToolNameSpec = string | ((name: string) => boolean);

export interface ToolCallOptions {
  name?: ToolNameSpec;
  state?: ToolUIPart['state'];
  input?: (input: unknown) => boolean;
  output?: (output: unknown) => boolean;
  errorText?: (text: string) => boolean;
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
