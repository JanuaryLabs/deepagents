import { type Tool, type ToolExecuteFunction, type ToolSet, tool } from 'ai';

export type ToolRecovery = 'idempotent';

export type ZukhrufTool<
  INPUT,
  OUTPUT,
  CONTEXT extends Record<string, unknown>,
> = Tool<INPUT, OUTPUT, CONTEXT> & {
  /** Allows one automatic replay after a worker crash. */
  recovery?: ToolRecovery;
};

export type ZukhrufToolSet = ToolSet &
  Record<string, { recovery?: ToolRecovery }>;

export function defineTool<
  INPUT,
  OUTPUT,
  CONTEXT extends Record<string, unknown>,
>(
  definition: ZukhrufTool<INPUT, OUTPUT, CONTEXT> & {
    execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT>;
  },
): ZukhrufTool<INPUT, OUTPUT, CONTEXT> & {
  execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT>;
};
export function defineTool<
  INPUT,
  OUTPUT,
  CONTEXT extends Record<string, unknown>,
>(
  definition: ZukhrufTool<INPUT, OUTPUT, CONTEXT>,
): ZukhrufTool<INPUT, OUTPUT, CONTEXT>;
export function defineTool<INPUT, CONTEXT extends Record<string, unknown>>(
  definition: ZukhrufTool<INPUT, never, CONTEXT>,
): ZukhrufTool<INPUT, never, CONTEXT>;
export function defineTool<OUTPUT, CONTEXT extends Record<string, unknown>>(
  definition: ZukhrufTool<never, OUTPUT, CONTEXT>,
): ZukhrufTool<never, OUTPUT, CONTEXT>;
export function defineTool<CONTEXT extends Record<string, unknown>>(
  definition: ZukhrufTool<never, never, CONTEXT>,
): ZukhrufTool<never, never, CONTEXT>;
export function defineTool(definition: unknown): unknown {
  return tool(definition as Tool);
}
