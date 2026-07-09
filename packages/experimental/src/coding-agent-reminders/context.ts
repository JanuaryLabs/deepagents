import type { ClaudeHookInput, ToolCallState, ToolNameSpec } from './types.ts';

export type NormalizedToolCall = {
  name: string;
  state: ToolCallState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export function contentText(ctx: ClaudeHookInput): string {
  return [ctx.prompt, ctx.command_name, ctx.command_args]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

export function bashCommand(ctx: ClaudeHookInput): string {
  if (ctx.tool_name !== 'Bash') return '';
  const command = ctx.tool_input?.command;
  return typeof command === 'string' ? command : '';
}

export function outputText(ctx: ClaudeHookInput): string {
  if (ctx.hook_event_name === 'PostToolBatch' && ctx.tool_calls) {
    return ctx.tool_calls
      .map((call) => textOf(call.tool_response))
      .filter(Boolean)
      .join('\n');
  }
  const output = ctx.tool_output ?? ctx.tool_response;
  return textOf(output);
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toolCallsOf(ctx: ClaudeHookInput): NormalizedToolCall[] {
  if (ctx.hook_event_name === 'PostToolBatch' && ctx.tool_calls) {
    return ctx.tool_calls.map((call) => ({
      name: call.tool_name,
      state: 'output-available',
      input: call.tool_input,
      output: call.tool_response,
    }));
  }

  const calls: NormalizedToolCall[] = [];
  const toolName = ctx.tool_name;
  if (typeof toolName === 'string') {
    calls.push({
      name: toolName,
      state: stateOf(ctx.hook_event_name),
      input: ctx.tool_input,
      output: ctx.tool_output ?? ctx.tool_response,
      errorText: errorTextOf(ctx),
    });
  }
  return calls;
}

export function matchesName(spec: ToolNameSpec, name: string): boolean {
  return typeof spec === 'function' ? spec(name) : spec === name;
}

function stateOf(eventName: string): ToolCallState {
  if (eventName === 'PostToolUseFailure') return 'output-error';
  if (eventName === 'PostToolUse') return 'output-available';
  return 'input-available';
}

function errorTextOf(ctx: ClaudeHookInput): string {
  const error =
    ctx.tool_error ??
    ctx.error ??
    ctx.reason ??
    ctx.tool_output ??
    ctx.tool_response;
  return textOf(error);
}
