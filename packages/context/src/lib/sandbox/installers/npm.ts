import { InstallError, MissingRuntimeError } from '../docker-sandbox-errors.ts';
import { Installer, type InstallerContext } from './installer.ts';

export interface NpmInstallerOptions {
  /**
   * Auto-install `nodejs` + `npm` via the container's package manager when
   * they're missing. Defaults to `false` — fail loudly with `MissingRuntimeError`.
   */
  ensureRuntime?: boolean;
  /** Optional version specifier (e.g. `'5.4.5'`). */
  version?: string;
}

const NODE_BINARIES = ['node', 'npm'];
const ENSURE_RUNTIME_HINT =
  'Pass `{ ensureRuntime: true }` to auto-install, or add it via `pkg([...])`.';

export class NpmInstaller extends Installer {
  readonly kind: string;
  readonly packageName: string;
  readonly options: NpmInstallerOptions;

  constructor(packageName: string, options: NpmInstallerOptions = {}) {
    super();
    this.packageName = packageName;
    this.options = options;
    this.kind = `npm:${packageName}`;
  }

  async install(ctx: InstallerContext): Promise<void> {
    await ensureNodeRuntime(ctx, this.options.ensureRuntime ?? false);

    const spec = this.options.version
      ? `${this.packageName}@${this.options.version}`
      : this.packageName;

    const result = await ctx.exec(`npm install -g ${spec}`);
    if (result.exitCode !== 0) {
      throw new InstallError({
        target: this.packageName,
        source: 'npm',
        reason: result.stderr,
        containerId: ctx.containerId,
      });
    }
  }
}

/**
 * Install a globally-available CLI from the npm registry.
 *
 * Default: fails loudly if `node`/`npm` are missing. Pass
 * `{ ensureRuntime: true }` to auto-install them.
 *
 * @example
 * ```ts
 * npm('prettier');                              // requires node+npm preinstalled
 * npm('prettier', { ensureRuntime: true });     // auto-installs node+npm
 * npm('typescript', { version: '5.4.5' });      // pinned version
 * ```
 */
export function npm(
  packageName: string,
  options?: NpmInstallerOptions,
): NpmInstaller {
  return new NpmInstaller(packageName, options);
}

async function ensureNodeRuntime(
  ctx: InstallerContext,
  ensure: boolean,
): Promise<void> {
  if (ensure) {
    await ctx.ensureTool('node', 'nodejs');
    await ctx.ensureTool('npm');
    return;
  }

  const check = await ctx.exec('which node && which npm');
  if (check.exitCode !== 0) {
    throw new MissingRuntimeError(
      'npm',
      NODE_BINARIES,
      ENSURE_RUNTIME_HINT,
      ctx.containerId,
    );
  }
}
