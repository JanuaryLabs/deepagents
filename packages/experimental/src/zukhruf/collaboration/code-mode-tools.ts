import { experimental_codeModeTool } from '@ai-sdk/code-mode';
import type { Tool, ToolSet } from 'ai';

import { ToolExposure, type ToolSurface } from './tool-exposure.ts';

/** The collaboration tools are callable only from the AI SDK `code_mode` tool. */
export class CodeModeTools extends ToolExposure {
  toolName(name: string): string {
    return `tools.${name}`;
  }

  callLine(toolNames: readonly string[]): string {
    return `Call ${this.listed(toolNames)} from \`code_mode\`.`;
  }

  tool<TOOL extends Tool>(collaborationTool: TOOL): TOOL {
    return collaborationTool;
  }

  surface<TOOLS extends ToolSet>(
    collaborationTools: TOOLS,
  ): ToolSurface<TOOLS> {
    const tools = {
      ...collaborationTools,
      code_mode: experimental_codeModeTool(),
    };
    return {
      tools,
      reservedToolNames: Object.keys(tools),
      toolCallers: Object.fromEntries(
        Object.keys(collaborationTools).map((name) => [
          name,
          ['code_mode'] as const,
        ]),
      ),
    };
  }

  callerContext<CONTEXT>(context: CONTEXT): { code_mode: CONTEXT } {
    return { code_mode: context };
  }
}
