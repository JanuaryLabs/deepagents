import type { experimental_codeModeTool } from '@ai-sdk/code-mode';
import type { Tool, ToolSet } from 'ai';

/** What a turn's model request carries for the collaboration tools. */
export interface ToolSurface<TOOLS extends ToolSet> {
  /** The tools the request carries, in request order. */
  readonly tools: TOOLS & {
    code_mode?: ReturnType<typeof experimental_codeModeTool>;
  };
  /** Names a plugin tool cannot take. */
  readonly reservedToolNames: readonly string[];
  /** AI SDK `experimental_toolCallers`, when another tool calls them. */
  readonly toolCallers:
    Readonly<Record<string, readonly ['code_mode']>> | undefined;
}

/** How the collaboration tools reach the model and how guidance names them. */
export abstract class ToolExposure {
  /** The name guidance uses for a collaboration tool. */
  abstract toolName(name: string): string;

  /** The guidance sentence that says where the model calls the tools. */
  abstract callLine(toolNames: readonly string[]): string;

  /** One collaboration tool as the request carries it. */
  abstract tool<TOOL extends Tool>(collaborationTool: TOOL): TOOL;

  abstract surface<TOOLS extends ToolSet>(
    collaborationTools: TOOLS,
  ): ToolSurface<TOOLS>;

  /** The tools context of the tools that call the collaboration tools. */
  abstract callerContext<CONTEXT>(context: CONTEXT): { code_mode?: CONTEXT };

  protected listed(toolNames: readonly string[]): string {
    return toolNames.map((name) => `\`${this.toolName(name)}\``).join(', ');
  }
}
