import type { CommandResult, Sandbox } from 'bash-tool';
import type { TransformPlugin } from 'just-bash';

export interface ExtensionCommandContext {
  sandbox: Sandbox;
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  signal?: AbortSignal;
}

export interface ExtensionCommand {
  name: string;
  handler: (
    args: string[],
    ctx: ExtensionCommandContext,
  ) => CommandResult | Promise<CommandResult>;
}

export type BashCallHook = (args: {
  command: string;
}) => { command: string } | Promise<{ command: string }>;

export interface SandboxExtension {
  commands?: ExtensionCommand[];
  plugins?: TransformPlugin[];
  onBeforeBashCall?: BashCallHook;
  env?: Record<string, string>;
}

export interface MergedSandboxExtension {
  commands: ExtensionCommand[];
  plugins: TransformPlugin[];
  env: Record<string, string>;
  onBeforeBashCall?: BashCallHook;
}

export class DuplicateCommandError extends Error {
  public readonly commandName: string;
  constructor(commandName: string) {
    super(`Duplicate extension command name: "${commandName}"`);
    this.name = 'DuplicateCommandError';
    this.commandName = commandName;
  }
}

export function chainHooks<T>(
  ...hooks: Array<(value: T) => T | Promise<T>>
): (value: T) => Promise<T> {
  return async (value) => {
    let current = value;
    for (const hook of hooks) {
      current = await hook(current);
    }
    return current;
  };
}

export function mergeExtensions(
  ...extensions: SandboxExtension[]
): MergedSandboxExtension {
  const commands: ExtensionCommand[] = [];
  const seen = new Set<string>();
  for (const ext of extensions) {
    for (const cmd of ext.commands ?? []) {
      if (seen.has(cmd.name)) throw new DuplicateCommandError(cmd.name);
      seen.add(cmd.name);
      commands.push(cmd);
    }
  }

  const hooks = extensions
    .map((e) => e.onBeforeBashCall)
    .filter((h): h is BashCallHook => !!h);

  return {
    commands,
    plugins: extensions.flatMap((e) => e.plugins ?? []),
    env: Object.assign({}, ...extensions.map((e) => e.env ?? {})),
    onBeforeBashCall: hooks.length > 0 ? chainHooks(...hooks) : undefined,
  };
}
