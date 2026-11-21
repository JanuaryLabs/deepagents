import type { Tool, ToolSet } from 'ai';

import { ToolExposure, type ToolSurface } from './tool-exposure.ts';
import type { ToolNamespace } from './tool-namespace.ts';

const NAMESPACE_DESCRIPTION = 'Tools for spawning and managing sub-agents.';

/** The collaboration tools sit on the model surface, optionally namespaced. */
export class DirectTools extends ToolExposure {
  readonly #namespace: ToolNamespace | undefined;

  constructor(namespace?: ToolNamespace) {
    super();
    this.#namespace = namespace;
  }

  toolName(name: string): string {
    return this.#namespace?.qualify(name) ?? name;
  }

  callLine(toolNames: readonly string[]): string {
    return `Call ${this.listed(toolNames)} directly. They are intentionally unavailable inside nested code execution.`;
  }

  tool<TOOL extends Tool>(collaborationTool: TOOL): TOOL {
    const openai = collaborationTool.providerOptions?.openai;
    return {
      ...collaborationTool,
      providerOptions: {
        ...collaborationTool.providerOptions,
        ...(this.#namespace === undefined
          ? {}
          : {
              openai: {
                ...(typeof openai === 'object' && openai !== null
                  ? openai
                  : {}),
                namespace: {
                  name: this.#namespace.name,
                  description: NAMESPACE_DESCRIPTION,
                },
              },
            }),
      },
    };
  }

  surface<TOOLS extends ToolSet>(
    collaborationTools: TOOLS,
  ): ToolSurface<TOOLS> {
    return {
      tools: collaborationTools,
      reservedToolNames: Object.keys(collaborationTools),
      toolCallers: undefined,
    };
  }

  callerContext(): Record<never, never> {
    return {};
  }
}
