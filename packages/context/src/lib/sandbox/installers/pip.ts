import { InstallError, MissingRuntimeError } from '../docker-sandbox-errors.ts';
import { Installer, type InstallerContext } from './installer.ts';

export interface PipInstallerOptions {
  /**
   * Auto-install `python3` + pip when missing. Defaults to `false` — fail
   * loudly with `MissingRuntimeError`.
   */
  ensureRuntime?: boolean;
  /** Version specifier (e.g. `'2.31.0'` or `'>=2.0,<3'`). */
  version?: string;
  /**
   * Pass `--break-system-packages` for PEP 668-protected images
   * (recent Debian/Ubuntu). Default `true` since this runs in an ephemeral
   * container where the protection adds no value.
   */
  breakSystemPackages?: boolean;
}

const PYTHON_BINARIES = ['python3', 'pip3'];

export class PipInstaller extends Installer {
  readonly kind: string;
  readonly packageName: string;
  readonly options: PipInstallerOptions;

  constructor(packageName: string, options: PipInstallerOptions = {}) {
    super();
    this.packageName = packageName;
    this.options = options;
    this.kind = `pip:${packageName}`;
  }

  async install(ctx: InstallerContext): Promise<void> {
    await ensurePythonRuntime(ctx, this.options.ensureRuntime ?? false);

    const spec = this.options.version
      ? `${this.packageName}${formatVersion(this.options.version)}`
      : this.packageName;

    const flags =
      (this.options.breakSystemPackages ?? true)
        ? '--break-system-packages'
        : '';

    const result = await ctx.exec(`pip3 install ${flags} ${spec}`.trim());
    if (result.exitCode !== 0) {
      throw new InstallError({
        target: this.packageName,
        source: 'pypi',
        reason: result.stderr,
        containerId: ctx.containerId,
      });
    }
  }
}

/**
 * Install a Python package via `pip3`.
 *
 * Default: fails loudly if `python3`/`pip3` are missing. Pass
 * `{ ensureRuntime: true }` to auto-install them.
 *
 * @example
 * ```ts
 * pip('requests');
 * pip('requests', { version: '2.31.0', ensureRuntime: true });
 * ```
 */
export function pip(
  packageName: string,
  options?: PipInstallerOptions,
): PipInstaller {
  return new PipInstaller(packageName, options);
}

async function ensurePythonRuntime(
  ctx: InstallerContext,
  ensure: boolean,
): Promise<void> {
  if (ensure) {
    const pipPackage = ctx.packageManager === 'apk' ? 'py3-pip' : 'python3-pip';
    await ctx.ensureTool('python3');
    await ctx.ensureTool('pip3', pipPackage);
    return;
  }

  const check = await ctx.exec('which python3 && which pip3');
  if (check.exitCode !== 0) {
    throw new MissingRuntimeError(
      'pip',
      PYTHON_BINARIES,
      'Pass `{ ensureRuntime: true }` to auto-install, or add via `pkg([...])` ' +
        '(Alpine: `python3 py3-pip`; Debian: `python3 python3-pip`).',
      ctx.containerId,
    );
  }
}

function formatVersion(version: string): string {
  return /^[<>=!~]/.test(version) ? version : `==${version}`;
}
