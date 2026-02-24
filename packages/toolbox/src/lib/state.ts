import type { ToolExecutionOptions } from 'ai';

export function toState<C>(options: ToolExecutionOptions): C {
  return options.experimental_context as C;
}
