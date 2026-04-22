# Sandbox v3 — Routing Layer + Portable Extensions

Plan for another agent to execute. Self-contained.

## Context

`createAgentSandbox` today hard-codes `just-bash`'s `Bash` class as the
execution backend. Extensions (`SandboxExtension`) are passed into `Bash`'s
constructor, which means the only way to run SQL-style host commands is
against just-bash's in-process bash emulator. Docker and Agent OS backends
(packages/context/src/lib/sandbox/docker-sandbox.ts,
packages/context/src/lib/sandbox/agent-os-sandbox.ts) can't participate — they
implement `bash-tool`'s `Sandbox` interface but have no dispatch for custom
commands.

Goal: extract the extension-dispatch layer into a reusable `createRoutingSandbox`
that accepts **any** `Sandbox` as its backend. Keep just-bash as one backend
(via `createVirtualSandbox`). Host-side commands work on every backend; the
only difference between backends is dispatch depth (deep for just-bash,
shallow for Docker/Agent OS).

## Final Shape

```ts
const sandbox = await createBashTool({
  sandbox: await createRoutingSandbox({
    backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
    //    or: await createDockerSandbox({ image: 'alpine' }),
    //    or: await createAgentOsSandbox({ software: [common] }),
    hostExtensions: [sqlSandboxExtension(adapter), myOtherExtension],
  }),
});
```

Same syntax across all three backends. Extension definitions are portable.

## Verified Facts About `just-bash`

Confirmed by inspecting `node_modules/just-bash/dist/` (do not re-check during implementation; these are settled):

- `parse` **is** publicly exported from `just-bash` (via `./parser/parser.js`).
- `Bash.prototype` methods: `constructor`, `registerCommand`, `exec`, `readFile`, `writeFile`, `getCwd`, `getEnv`, `registerTransformPlugin`, `transform`. **No runtime `addCustomCommand`**. `customCommands` must be passed via `BashOptions`. Lazy construction inside `createVirtualSandbox.install` is therefore required.
- `TransformPlugin<M>` operates on **AST**, not strings:
  `transform(ctx: { ast: ScriptNode; metadata: unknown }): { ast: ScriptNode; metadata?: M }`.
  Plugins can throw `BashException` (see `SqlProxyEnforcementPlugin` throwing `SqlProxyViolationError`).
- `Bash.transform(commandLine: string): { script, ast, metadata }` runs the registered plugins and returns a serialized string. **This is the shallow router's path for applying plugins** — spin up a throw-away Bash with only the plugins registered, call `.transform(raw)`, take `result.script`.
- `Bash.writeFile(path, content)` calls `fs.writeFile(resolved, content)`. It does **not** auto-create parent directories. `DockerSandbox.writeFiles` (docker-sandbox.ts:528-533) **does** `mkdir -p` first. Handlers that want portability must run `mkdir -p` explicitly.
- `bash-tool`'s `Sandbox` interface: `executeCommand(cmd: string)`, `readFile(path: string)`, `writeFiles(files: Array<{ path; content }>)`. No `env` propagation, no `cwd` control, no stdin.

## Locked Decisions

- **Naming.** `createVirtualSandbox()` (just-bash backed, was "BuiltinBashBackend"). `createRoutingSandbox({ backend, hostExtensions })`. Interface: `InstallableSandbox`. Method: `install(ext)`.
- **Filesystem.** Extension commands receive `ctx.sandbox: Sandbox` — not `ctx.fs: IFileSystem`. All writes/reads go through `sandbox.writeFiles` / `sandbox.readFile`. No in-memory mirror, no post-handler drain.
- **`ExtensionCommand` lives in `extension.ts`** (same module as `SandboxExtension`). `routing-sandbox.ts` imports it. Single direction — no cycle.
- **Duplicate command names** across extensions → `mergeExtensions` throws `DuplicateCommandError` at merge time. `DuplicateCommandError` uses `commandName` field (not `name`) so `err.name` remains the class name.
- **No read-through fs adapter.** Handlers that need prior-call state read via `ctx.sandbox.readFile(path)` directly. If backend doesn't have the file, the call fails — same as any bash `cat` would.
- **No upstream PR or fork of `just-bash`.** Work within its constructor-configured extension surface.
- **No compat shims.** Old `defineSubcommandGroup` + `CustomCommand`-typed `SandboxExtension.commands` get deleted; all callers migrate in the same commit. (AGENTS.md policy.)
- **`createVirtualSandbox` is async** for consistency with other factories, even though just-bash construction is sync.
- **Install-once.** `InstallableSandbox.install(ext)` throws if called twice. `createRoutingSandbox` always calls it during construction (with merged extensions). `createVirtualSandbox` throws on any `executeCommand` / `readFile` / `writeFiles` call made before `install` — callers are expected to wrap it via `createRoutingSandbox` before use.
- **Shallow router does not catch `BashException`.** Single catch stays in `createBashTool`'s wrapper (packages/context/src/lib/sandbox/bash-tool.ts:60). Plugins and host commands that throw `BashException` propagate up and get formatted once.
- **Plugin semantics on shallow dispatch.** Plugins operate on AST. The shallow router maintains a throw-away `Bash` instance internally to apply plugins (via `Bash.transform`). This preserves parity with deep dispatch — same plugin code, same AST-level semantics — across all backends.
- **Hook chain order**: `createBashTool.onBeforeBashCall` (instrumentation) → routing layer's extension `onBeforeBashCall` (dispatch rewriting) → plugins (AST-level) → command match or backend.
- **`stdin` for host commands is always empty** on shallow dispatch. Pipeline boundary limitation documented (see below).
- **Dispose**: routing sandbox spreads over `backend`, so `dispose()` (if present) forwards automatically.
- **Extension `env` is host-command-only.** On shallow dispatch, `ext.env` is passed to host handlers via `ctx.env`. It is **not** propagated to the backend's `executeCommand` — `bash-tool`'s `Sandbox.executeCommand` has no env parameter. If you need backend env, configure it at backend-construction (Docker `env: {...}`, Agent OS, etc.). Document.
- **`createAgentSandbox` is only virtual-backed.** Docker/AgentOS callers assemble `createBashTool({ sandbox: createRoutingSandbox({ backend, hostExtensions }) })` directly. `drainFileEvents` is only available via `createAgentSandbox`. Document.
- **AST helpers live in `packages/context/src/lib/sandbox/ast-utils.ts`.** Move `asStaticWordText` + `asStaticWordPartText` out of `packages/text2sql/src/lib/agents/sql-transform-plugins.ts` (lines 20-63). Verified: only one caller (the plugins file itself). `routing-sandbox.ts` and `sql-transform-plugins.ts` both import from the new module.

## Known Limitations (Document Explicitly)

- **Pipeline boundary on shallow dispatch**: Host commands dispatch only at the top level on Docker/Agent OS backends. `sql run "..." | jq .` works on the virtual backend (Bash parses the pipeline and matches `sql` inside) but **not** on Docker/Agent OS (the whole line runs in the container, which has no `sql` binary). Users pipe `sql run` output by piping `cat /sql/{uuid}.json | jq .` in a separate turn, or by using the virtual backend.
- **Host handlers see no stdin** on shallow dispatch.
- **`drainFileEvents`** only reflects writes against the virtual backend's `IFileSystem` (including writes that host handlers make via `ctx.sandbox.writeFiles`, because those route through Bash's fs). On Docker/Agent OS backends, `drainFileEvents` returns `[]` or is omitted.
- **Plugin error format context may differ by a small amount between deep and shallow dispatch.** Deep dispatch: plugin throws inside `Bash.exec`'s pipeline, `BashException.format()` sees it, wrapper converts. Shallow dispatch: plugin throws inside the side-Bash's `Bash.transform`, same `BashException.format()` sees it, same wrapper converts. The `CommandResult` shape is identical; the internal stack trace is not. Documented.

## Files to Create

### `packages/context/src/lib/sandbox/routing-sandbox.ts`

Core primitive. Note: `ExtensionCommand` / `ExtensionCommandContext` / `DuplicateCommandError` are defined in `extension.ts` and imported here (single-direction dependency).

```ts
import type { CommandResult, Sandbox } from 'bash-tool';
import {
  Bash,
  type CustomCommand,
  type IFileSystem,
  type TransformPlugin,
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

// ─────────────────────────────────────────────────────────────────────────
// Capability protocol
// ─────────────────────────────────────────────────────────────────────────

export interface InstallableSandbox extends Sandbox {
  install(ext: MergedSandboxExtension): void | Promise<void>;
}

export function isInstallable(s: Sandbox): s is InstallableSandbox {
  return typeof (s as Partial<InstallableSandbox>).install === 'function';
}

// ─────────────────────────────────────────────────────────────────────────
// Virtual sandbox — just-bash backed, opts into deep dispatch.
//
// Not usable before install() returns. createRoutingSandbox calls install()
// during construction, so the only way a pre-install op can fire is if a
// caller uses createVirtualSandbox directly and skips the routing wrap —
// which we explicitly disallow by throwing on pre-install access.
// ─────────────────────────────────────────────────────────────────────────

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

  // Declared via the object literal below so handlers can close over a
  // stable Sandbox reference. See adaptExtensionCommandForBash.
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
        ...options,
        customCommands: adapted,
      });
      for (const plugin of ext.plugins) {
        bash.registerTransformPlugin(plugin);
      }
    },

    async executeCommand(command) {
      const b = ensureInstalled('executeCommand');
      const result = await b.exec(command);
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
      const b = ensureInstalled('writeFiles');
      for (const f of files) {
        await b.writeFile(
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

// ─────────────────────────────────────────────────────────────────────────
// createRoutingSandbox — single entry point, backend-aware.
// ─────────────────────────────────────────────────────────────────────────

export interface CreateRoutingSandboxOptions {
  backend: Sandbox;
  hostExtensions: SandboxExtension[];
}

export async function createRoutingSandbox(
  opts: CreateRoutingSandboxOptions,
): Promise<Sandbox> {
  const merged = mergeExtensions(...opts.hostExtensions);

  if (isInstallable(opts.backend)) {
    // Deep dispatch: backend handles command matching, plugins, pipelines
    // natively. Only apply the extension's onBeforeBashCall at our layer.
    await opts.backend.install(merged);
    return wrapPreCallHook(opts.backend, merged.onBeforeBashCall);
  }

  // Shallow dispatch: first-token match + side-Bash for plugin transforms.
  return createShallowRouter(opts.backend, merged);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function wrapPreCallHook(backend: Sandbox, hook?: BashCallHook): Sandbox {
  if (!hook) return backend;
  return {
    ...backend,
    executeCommand: async (raw) => {
      const { command } = await hook({ command: raw });
      return backend.executeCommand(command);
    },
  };
}

function createShallowRouter(
  backend: Sandbox,
  ext: MergedSandboxExtension,
): Sandbox {
  const byName = new Map(ext.commands.map((c) => [c.name, c]));
  // Invariant: mergeExtensions threw on duplicates, so Map size matches list.

  // Side Bash used solely for AST-level plugin transforms. We pass no custom
  // commands and no fs — we never call .exec() on this instance.
  const transformer = new Bash({});
  for (const plugin of ext.plugins) {
    transformer.registerTransformPlugin(plugin);
  }

  return {
    ...backend,
    executeCommand: async (raw) => {
      // 1. Extension pre-call hook.
      const preHook = ext.onBeforeBashCall
        ? (await ext.onBeforeBashCall({ command: raw })).command
        : raw;

      // 2. Run plugins (AST-level) if any are registered. Plugins may throw
      //    BashException subclasses; we do not catch — createBashTool's
      //    wrapper formats them.
      const transformed =
        ext.plugins.length > 0
          ? transformer.transform(preHook).script
          : preHook;

      // 3. Parse to locate the first token for host-command dispatch.
      let tokens: string[];
      try {
        tokens =
          parse(transformed).statements[0]?.pipelines[0]?.commands[0]?.type ===
          'SimpleCommand'
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
          cwd: '/',
          env: ext.env,
          stdin: '',
        });
      }

      return backend.executeCommand(transformed);
    },
  };
}

// Tokenize only the first simple-command of a parsed script (name + args).
// Pipelines, redirections, and subshells are forwarded to the backend as a
// whole string — the shallow router does not dispatch inside them.
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

// `asStaticWordText` is imported from './ast-utils.ts' above. It extracts
// a static string from a WordNode's parts, handling
// Literal/SingleQuoted/Escaped/DoubleQuoted; returns null on any dynamic
// part (CommandSubstitution, ParameterExpansion, etc.).

// ─────────────────────────────────────────────────────────────────────────
// Adapter: ExtensionCommand → just-bash CustomCommand
// ─────────────────────────────────────────────────────────────────────────

function adaptExtensionCommandForBash(
  ext: ExtensionCommand,
  getSandbox: () => Sandbox,
): CustomCommand {
  return defineCommand(ext.name, async (args, bashCtx) => {
    return ext.handler(args, {
      sandbox: getSandbox(),
      cwd: bashCtx.cwd,
      env: bashCtx.env,
      stdin: bashCtx.stdin,
    });
  });
}
```

**Implementation notes:**

- AST helpers (`asStaticWordText` + `asStaticWordPartText`) move to `packages/context/src/lib/sandbox/ast-utils.ts`. Exact source: `packages/text2sql/src/lib/agents/sql-transform-plugins.ts:20-63`. Update the plugins file to import from the new module. No other callers exist (grep-verified).
- `tokenizeFirstCommand` returns `[]` for any pipeline/subshell/redirection-containing line. That's the "don't dispatch inside complex constructs" rule. Caller treats empty-tokens as "no match, forward to backend."
- `transformer` side-Bash is cheap (just-bash construction is in-memory). One per routing-sandbox instance is fine.

## Files to Modify

### `packages/context/src/lib/sandbox/extension.ts`

Add `ExtensionCommand`, `ExtensionCommandContext`, `DuplicateCommandError`. Change `SandboxExtension.commands` to `ExtensionCommand[]`. Make `mergeExtensions` throw on duplicates.

```ts
import type { CommandResult, Sandbox } from 'bash-tool';
import type { TransformPlugin } from 'just-bash';

// ──────────────────────────────────────────────────────────────────────
// Portable command shape
// ──────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────
// Hook
// ──────────────────────────────────────────────────────────────────────

export type BashCallHook = (args: {
  command: string;
}) => { command: string } | Promise<{ command: string }>;

// ──────────────────────────────────────────────────────────────────────
// Extension
// ──────────────────────────────────────────────────────────────────────

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
```

### `packages/context/src/lib/sandbox/index.ts`

Add: `export * from './routing-sandbox.ts';`

### `packages/context/src/lib/sandbox/create-agent-sandbox.ts`

Breaking change: drop `customCommands` / `plugins` / `onBeforeBashCall` options. Add a single `extensions: SandboxExtension[]` option. `createAgentSandbox` is only virtual-backed.

```ts
export interface CreateAgentSandboxOptions extends Omit<
  CreateBashToolWithSkillsOptions,
  'sandbox'
> {
  fs: IFileSystem;
  extensions?: SandboxExtension[];
  cwd?: string;
  env?: Record<string, string>;
}

export async function createAgentSandbox(
  options: CreateAgentSandboxOptions,
): Promise<AgentSandbox> {
  const { fs, extensions = [], cwd, env, ...bashToolOptions } = options;
  const observed = new ObservedFs(fs);

  const backend = await createVirtualSandbox({ fs: observed, cwd, env });
  const routed = await createRoutingSandbox({
    backend,
    hostExtensions: extensions,
  });

  const sandbox = await createBashTool({
    ...bashToolOptions,
    sandbox: routed,
  });

  return { ...sandbox, drainFileEvents: () => observed.drain() };
}
```

The old `customCommands` / `plugins` / `onBeforeBashCall` fields go away with no deprecation shim (AGENTS.md).

### `packages/context/src/lib/sandbox/subcommand.ts`

Replace `defineSubcommandGroup` to return an `ExtensionCommand` (not just-bash's `CustomCommand`). The subcommand dispatch logic is unchanged; only the input/output types change. Same file, same exported name, same signature — only the output shape differs. Verify every caller (grep `defineSubcommandGroup`) — currently only `packages/text2sql/src/lib/agents/sql-command.ts` uses it. Migrate inline.

```ts
export function defineSubcommandGroup(
  name: string,
  subcommands: Record<string, SubcommandDefinition>,
): ExtensionCommand {
  const usageLines = Object.entries(subcommands)
    .map(([, def]) => `  ${name} ${def.usage.padEnd(30)} ${def.description}`)
    .join('\n');

  return {
    name,
    handler: async (args, ctx) => {
      const subcommand = args[0];
      const restArgs = args.slice(1);
      if (subcommand && subcommand in subcommands) {
        return subcommands[subcommand].handler(restArgs, ctx);
      }
      return {
        stdout: '',
        stderr: `${name}: ${subcommand ? `unknown subcommand '${subcommand}'` : 'missing subcommand'}\n\nUsage:\n${usageLines}`,
        exitCode: 1,
      };
    },
  };
}
```

`SubcommandDefinition.handler` now takes `ExtensionCommandContext` (not just-bash's `CommandContext`):

```ts
export interface SubcommandDefinition {
  usage: string;
  description: string;
  repair?: (rawArgs: string) => string | null;
  handler: (
    args: string[],
    ctx: ExtensionCommandContext,
  ) => CommandResult | Promise<CommandResult>;
}
```

`buildSubcommandRepair` stays unchanged (it operates on raw command strings).

### `packages/text2sql/src/lib/agents/sql-command.ts`

Rewrite `handler` bodies to use `ctx.sandbox` (Sandbox API) instead of `ctx.fs` (IFileSystem). **Preserve all user-visible strings verbatim** — stdout/stderr text must not drift.

Translation rules:

- `ctx.fs.mkdir('/sql', { recursive: true })` → `await ctx.sandbox.executeCommand('mkdir -p /sql')`. Check exitCode; bail with stderr if non-zero.
- `ctx.fs.writeFile(path, content)` → `await ctx.sandbox.writeFiles([{ path, content }])`.
- `ctx.fs.readFile(path)` → `await ctx.sandbox.readFile(path)`.

Only `run` uses fs operations in the current file (packages/text2sql/src/lib/agents/sql-command.ts:56-57). `validate` has no fs access. Target body for `run`:

```ts
handler: async (args, ctx) => {
  const meta = useBashMeta();
  meta?.setReminder(SQL_VALIDATE_REMINDER);

  const rawQuery = args.join(' ').trim();
  if (!rawQuery) {
    return { stdout: '', stderr: 'sql run: no query provided', exitCode: 1 };
  }

  const query = adapter.format(rawQuery);
  meta?.setHidden({ formattedSql: query });

  const syntaxError = await adapter.validate(query);
  if (syntaxError) {
    return { stdout: '', stderr: `sql run: ${syntaxError}`, exitCode: 1 };
  }

  try {
    const rows = await adapter.execute(query);
    const rowsArray = Array.isArray(rows) ? rows : [];
    const content = JSON.stringify(rowsArray, null, 2);

    const filename = `${v7()}.json`;
    const sqlPath = `/sql/${filename}`;

    const mkdir = await ctx.sandbox.executeCommand('mkdir -p /sql');
    if (mkdir.exitCode !== 0) {
      return {
        stdout: '',
        stderr: `sql run: failed to create /sql: ${mkdir.stderr}`,
        exitCode: 1,
      };
    }
    await ctx.sandbox.writeFiles([{ path: sqlPath, content }]);

    const columns =
      rowsArray.length > 0 ? Object.keys(rowsArray[0] as object) : [];

    return {
      stdout:
        [
          `results stored in ${sqlPath}`,
          `columns: ${columns.join(', ') || '(none)'}`,
          `rows: ${rowsArray.length}`,
        ].join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: '',
      stderr: `sql run: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }
},
```

Verify the exact stdout phrasing (`'results stored in'`, `'columns: '`, `'rows: '`) matches the current file (packages/text2sql/src/lib/agents/sql-command.ts:63-67). Do not drift.

### `packages/text2sql/src/lib/sandbox.ts`

After `defineSubcommandGroup` returns `ExtensionCommand`, `sqlSandboxExtension` compiles as-is (its `commands: [command]` array holds an `ExtensionCommand`). No change to this file.

## Call Site Migration

All call sites currently use `...mergeExtensions(sqlSandboxExtension(adapter))` spread into `createAgentSandbox`. After the refactor, use the new `extensions` option:

```diff
 const sandbox = await createAgentSandbox({
   fs: new InMemoryFs(),
-  ...mergeExtensions(sqlSandboxExtension(adapter)),
+  extensions: [sqlSandboxExtension(adapter)],
 });
```

Files to update (grep for `mergeExtensions(sqlSandboxExtension`):

- `packages/text2sql/src/evals/helpers/conversation-simulator.ts`
- `packages/text2sql/src/evals/formatting/formatting.eval.ts`
- `apps/docs/app/app.tsx`
- `apps/docs/app/docs/text2sql/getting-started.mdx` (5 occurrences)
- `apps/docs/app/docs/text2sql/index.mdx`
- `apps/docs/app/docs/text2sql/teach-the-system.mdx`
- `apps/docs/app/docs/text2sql/history.mdx` (2 occurrences)
- `apps/docs/app/docs/text2sql/build-conversations.mdx`
- `apps/docs/app/docs/text2sql/sqlv3.mdx`
- `packages/text2sql/README.md`
- `packages/text2sql/sqlv3.md`

Also drop the `mergeExtensions` spread pattern from docs entirely; the canonical shape is `extensions: [...]`.

Advanced pattern (Docker / Agent OS) goes in `packages/text2sql/sqlv3.md`:

```ts
const sandbox = await createBashTool({
  sandbox: await createRoutingSandbox({
    backend: await createDockerSandbox({ image: 'alpine' }),
    hostExtensions: [sqlSandboxExtension(adapter)],
  }),
});
```

Note: this path bypasses `createAgentSandbox`, so `drainFileEvents` won't be available on the returned `AgentSandbox`. Callers who need file events must use the virtual backend (via `createAgentSandbox`).

## Tests to Add

### `packages/context/test/routing-sandbox.test.ts`

- `createVirtualSandbox` + `createRoutingSandbox` + empty extensions → basic bash (`ls`, `echo`) works on the virtual backend.
- Single extension with one command → command dispatches on virtual backend.
- Shallow dispatch with same extension against `FakeInMemorySandbox` (spec'd below) → command dispatches at top level.
- Shallow dispatch: top-level command that does not match any extension → forwarded to backend verbatim (assert `backend.executeCommand` received the transformed line).
- Shallow dispatch: pipeline `echo x | grep y` where neither side matches any extension → forwarded to backend as a single string; extension handlers are not invoked.
- Shallow dispatch: `sql run "..." | jq` → extension handler is **not** called (pipeline boundary); whole line forwarded.
- `mergeExtensions` throws `DuplicateCommandError` on colliding command names; `err.name === 'DuplicateCommandError'`, `err.commandName === 'duplicated-name'`.
- `onBeforeBashCall` chains correctly across multiple extensions (pre-existing test already covers chainHooks).
- Host command writes via `ctx.sandbox.writeFiles` → subsequent `ctx.sandbox.readFile` returns the content (on both backends).
- Install-once: second `install()` on the same virtual sandbox throws.
- Pre-install access: `virtualSandbox.executeCommand('x')` before install throws with a helpful error.
- Plugin ordering: two plugins that each append a literal token to the command; assert both run in declared order on shallow dispatch (use the side-Bash transform path).
- `createAgentSandbox` with `skills: [{ host, sandbox }]` → skills are copied into the sandbox fs (regression: extension refactor must not break skill upload).

### `packages/context/test/routing-sandbox-parity.test.ts`

Parity matrix: same extension + same command, run through virtual sandbox _and_ `FakeInMemorySandbox`. Both produce the same `CommandResult` for:

- Top-level command with no args: `foo`
- Top-level command with one quoted arg: `foo "hello world"`
- Top-level command with multi-arg quoted: `foo a "b c" d`
- Top-level command that calls `ctx.sandbox.writeFiles` + `ctx.sandbox.readFile` round-trip.

**Do not** assert parity for pipelines, redirects, subshells — deep dispatches them, shallow forwards them.

`FakeInMemorySandbox` spec (implemented in `packages/context/test/helpers/fake-sandbox.ts`):

```ts
export class FakeInMemorySandbox implements Sandbox {
  #files = new Map<string, string>();

  async executeCommand(command: string): Promise<CommandResult> {
    // Only responds to `mkdir -p <path>` (no-op, success) and otherwise
    // returns { stdout: '', stderr: 'command not found: <first token>\n', exitCode: 127 }.
    if (/^mkdir -p \S+$/.test(command.trim())) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    const first = command.trim().split(/\s+/)[0];
    return {
      stdout: '',
      stderr: `command not found: ${first}\n`,
      exitCode: 127,
    };
  }

  async readFile(path: string): Promise<string> {
    const content = this.#files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFiles(files: Array<{ path: string; content: string | Buffer }>) {
    for (const f of files) {
      this.#files.set(
        f.path,
        typeof f.content === 'string' ? f.content : f.content.toString('utf-8'),
      );
    }
  }
}
```

### Regression

- `packages/text2sql/test/chat.integration.test.ts` — must continue passing unchanged. The internals of `createAgentSandbox` changed, but the public surface (`Text2Sql` + chat) is identical.
- `packages/context/test/extension.test.ts` — existing tests for `mergeExtensions` + `chainHooks` already written. Update the "concatenates commands and plugins in order" test to assert `DuplicateCommandError` on a new test case.

## Verification

Run in this order:

1. `nx run context:build`
2. `nx run context:typecheck`
3. `node --test --no-warnings packages/context/test/extension.test.ts`
4. `node --test --no-warnings packages/context/test/routing-sandbox.test.ts`
5. `node --test --no-warnings packages/context/test/routing-sandbox-parity.test.ts`
6. `nx run text2sql:build`
7. `nx run text2sql:typecheck`
8. `node --test --no-warnings packages/text2sql/test/chat.integration.test.ts`
9. Smoke: `node -e "const t = require('./packages/text2sql/dist/index.js'); const c = require('./packages/context/dist/index.js'); console.log('virtual:', typeof c.createVirtualSandbox, 'routing:', typeof c.createRoutingSandbox, 'ext:', typeof t.sqlSandboxExtension, 'dup-err:', typeof c.DuplicateCommandError);"`

All steps must succeed.

## Out of Scope

- Upstream changes to `just-bash`.
- Read-through fs adapter (handlers reading files written on prior calls).
- Pipeline-aware shallow dispatch.
- `drainFileEvents` for Docker / Agent OS backends.
- Backend `env` propagation via `bash-tool.Sandbox.executeCommand`.
- Multi-adapter routing for SQL (unchanged from prior scope).

## Success Criteria

- `createVirtualSandbox`, `createRoutingSandbox`, `InstallableSandbox`, `ExtensionCommand`, `ExtensionCommandContext`, `DuplicateCommandError` exported from `@deepagents/context`.
- `sqlSandboxExtension(adapter)` works unchanged at call sites after swapping the spread for `extensions: [...]`.
- Every backend (virtual, Docker, Agent OS) composes with the SQL extension through the same `createRoutingSandbox` call.
- All existing chat integration tests pass.
- New routing-sandbox test suite + parity test suite pass.
- Skills upload continues to work through `createAgentSandbox`.
- Docs updated: `apps/docs/app/docs/context/sandbox.mdx` notes the pipeline-boundary limitation; `apps/docs/app/docs/text2sql/sqlv3.mdx` shows the Docker / Agent OS composition pattern.
