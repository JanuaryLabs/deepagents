const RESERVED_TOOL_NAMESPACES = new Set([
  'api_tool',
  'browser',
  'computer',
  'container',
  'file_search',
  'functions',
  'image_gen',
  'multi_tool_use',
  'python',
  'python_user_visible',
  'submodel_delegator',
  'terminal',
  'tool_search',
  'web',
]);

/** Native OpenAI Responses namespace that groups tools under one name. */
export class ToolNamespace {
  readonly name: string;

  constructor(name: string) {
    if (name.length === 0 || name.trim() !== name) {
      throw new Error('AgentRuntime: ToolNamespace cannot be empty or padded');
    }
    if (
      name.length > 64 ||
      !/^[a-zA-Z0-9_-]+$/.test(name) ||
      name === 'mcp' ||
      name.startsWith('mcp__') ||
      RESERVED_TOOL_NAMESPACES.has(name)
    ) {
      throw new Error(
        `AgentRuntime: ToolNamespace "${name}" is a reserved tool namespace or invalid`,
      );
    }
    this.name = name;
  }

  qualify(toolName: string): string {
    return `${this.name}.${toolName}`;
  }
}
