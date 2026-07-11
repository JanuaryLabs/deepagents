import type { ToolExecutionOptions } from 'ai';

export function toState<C>(options: ToolExecutionOptions<any>): C {
  return options.context as C;
}
