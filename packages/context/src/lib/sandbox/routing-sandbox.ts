import type { Sandbox } from 'bash-tool';
import {
  Bash,
  type CommandContext,
  type CustomCommand,
  type IFileSystem,
  defineCommand,
  parse,
} from 'just-bash';

import { asStaticWordText } from './ast-utils.ts';
import {
  type BashCallHook,
  type ExtensionCommand,
  type MergedSandboxExtension,
  type SandboxExtension,
  mergeExtensions,
} from './extension.ts';

export interface InstallableSandbox extends Sandbox {
  install(ext: MergedSandboxExtension): void | Promise<void>;
}

export function isInstallable(s: Sandbox): s is InstallableSandbox {
  return typeof (s as Partial<InstallableSandbox>).install === 'function';
}

export interface CreateVirtualSandboxOptions {
  fs: IFileSystem;
  cwd?: string;
  env?: Record<string, string>;
}

export async function createVirtualSandbox(
  options: CreateVirtualSandboxOptions,
): Promise<InstallableSandbox> {
  let bash: Bash | null = null;

  const ensureInstalled = (op: string): Bash => {
    if (!bash) {
      throw new Error(
        `createVirtualSandbox: ${op} called before install(). Wrap this sandbox with createRoutingSandbox before use.`,
      );
    }
    return bash;
  };

  const sandbox: InstallableSandbox = {
    async install(ext) {
      if (bash) {
        throw new Error(
          'createVirtualSandbox: install() called twice (extensions are install-once)',
        );
      }
      const adapted = ext.commands.map((cmd) =>
        adaptExtensionCommandForBash(cmd, () => sandbox),
      );
      bash = new Bash({
        fs: options.fs,
        cwd: options.cwd,
        env: { ...options.env, ...ext.env },
        customCommands: adapted,
      });
      for (const plugin of ext.plugins) {
        bash.registerTransformPlugin(plugin);
      }
    },

    async executeCommand(command) {
      const instance = ensureInstalled('executeCommand');
      const result = await instance.exec(command);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },

    async readFile(path) {
      return ensureInstalled('readFile').readFile(path);
    },

    async writeFiles(files) {
      const instance = ensureInstalled('writeFiles');
      for (const f of files) {
        await instance.writeFile(
          f.path,
          typeof f.content === 'string'
            ? f.content
            : Buffer.from(f.content).toString('utf-8'),
        );
      }
    },
  };

  return sandbox;
}

export interface CreateRoutingSandboxOptions {
  /**
   * Backend sandbox to wrap. Single-use — the same `InstallableSandbox`
   * cannot be passed to two routing sandboxes (install() is install-once).
   */
  backend: Sandbox;
  hostExtensions: SandboxExtension[];
  /**
   * Working directory surfaced to host handlers via `ctx.cwd` on shallow
   * dispatch. Defaults to `/`. Deep dispatch uses the backend's own cwd.
   */
  cwd?: string;
}

export async function createRoutingSandbox(
  opts: CreateRoutingSandboxOptions,
): Promise<Sandbox> {
  const merged = mergeExtensions(...opts.hostExtensions);

  if (isInstallable(opts.backend)) {
    await opts.backend.install(merged);
    return wrapPreCallHook(opts.backend, merged.onBeforeBashCall);
  }

  return createShallowRouter(opts.backend, merged, opts.cwd ?? '/');
}

function wrapPreCallHook(backend: Sandbox, hook?: BashCallHook): Sandbox {
  if (!hook) return backend;
  return {
    executeCommand: async (raw) => {
      const { command } = await hook({ command: raw });
      return backend.executeCommand(command);
    },
    readFile: (path) => backend.readFile(path),
    writeFiles: (files) => backend.writeFiles(files),
  };
}

function createShallowRouter(
  backend: Sandbox,
  ext: MergedSandboxExtension,
  cwd: string,
): Sandbox {
  const byName = new Map(ext.commands.map((c) => [c.name, c]));

  // Transform-only: this Bash never executes. Plugins operate on AST; no fs required.
  const transformer = new Bash({});
  for (const plugin of ext.plugins) {
    transformer.registerTransformPlugin(plugin);
  }

  return {
    readFile: (path) => backend.readFile(path),
    writeFiles: (files) => backend.writeFiles(files),
    executeCommand: async (raw) => {
      const preHook = ext.onBeforeBashCall
        ? (await ext.onBeforeBashCall({ command: raw })).command
        : raw;

      let transformed: string;
      let tokens: string[];
      try {
        transformed =
          ext.plugins.length > 0
            ? transformer.transform(preHook).script
            : preHook;
        const firstCmd =
          parse(transformed).statements[0]?.pipelines[0]?.commands[0];
        tokens =
          firstCmd?.type === 'SimpleCommand'
            ? tokenizeFirstCommand(transformed)
            : [];
      } catch (err) {
        return {
          stdout: '',
          stderr: `parse error: ${(err as Error).message}\n`,
          exitCode: 2,
        };
      }

      const [name, ...args] = tokens;
      const cmd = name ? byName.get(name) : undefined;

      if (cmd) {
        return cmd.handler(args, {
          sandbox: backend,
          cwd,
          env: ext.env,
          stdin: '',
        });
      }

      return backend.executeCommand(transformed);
    },
  };
}

function tokenizeFirstCommand(commandLine: string): string[] {
  const ast = parse(commandLine);
  const first = ast.statements[0]?.pipelines[0]?.commands[0];
  if (!first || first.type !== 'SimpleCommand') return [];
  if (ast.statements.length > 1) return [];
  if (ast.statements[0].pipelines.length > 1) return [];
  if (ast.statements[0].pipelines[0].commands.length > 1) return [];
  if (first.redirections.length > 0) return [];

  const name = asStaticWordText(first.name);
  if (!name) return [];
  const args: string[] = [];
  for (const arg of first.args) {
    const text = asStaticWordText(arg);
    if (text == null) return [];
    args.push(text);
  }
  return [name, ...args];
}

function adaptExtensionCommandForBash(
  ext: ExtensionCommand,
  getSandbox: () => Sandbox,
): CustomCommand {
  return defineCommand(ext.name, async (args, bashCtx: CommandContext) => {
    return ext.handler(args, {
      sandbox: getSandbox(),
      cwd: bashCtx.cwd,
      env: Object.fromEntries(bashCtx.env),
      stdin: bashCtx.stdin,
      signal: bashCtx.signal,
    });
  });
}
