import { basename, posix } from 'node:path';

import { InstallError } from '../docker-sandbox-errors.ts';
import { Installer, type InstallerContext, shellQuote } from './installer.ts';

export interface BinInstallerOptions {
  /**
   * Command name exposed on PATH. Defaults to the binary basename without
   * its file extension (e.g. `/workspace/dist/sql.js` → `sql`).
   */
  name?: string;
  /**
   * Full path of the symlink. Defaults to `/usr/local/bin/${name}`.
   */
  target?: string;
}

const NOT_FOUND_EXIT = 11;
const CHMOD_FAILED_EXIT = 12;

/**
 * Expose a binary that already exists inside the container as a command on
 * `PATH`. Pair with a bind-mounted workspace to skip `docker build` and
 * esbuild bake-in during dev — rebuild the binary on the host, rerun the
 * command in the sandbox.
 *
 * The command name defaults to the binary basename without its extension
 * (e.g. `sql.js` → `sql`). Override with `name` or `target`. Fails loudly
 * with `InstallError` (`kind: 'bin'`) when the file is missing or non-
 * executable on a read-only mount — no silent dangling symlinks.
 *
 * @example
 * ```ts
 * bin('/workspace/packages/text2sql/dist/bin/sql.js');         // → `sql` on PATH
 * bin('/opt/tools/cli.mjs', { name: 'tool' });                 // custom name
 * bin('/opt/tools/cli.mjs', { target: '/opt/bin/tool' });      // custom target
 * ```
 */
export class BinInstaller extends Installer {
  readonly kind: string;
  readonly binary: string;
  readonly options: BinInstallerOptions;
  readonly #name: string;
  readonly #target: string;

  constructor(binary: string, options: BinInstallerOptions = {}) {
    super();
    this.binary = binary;
    this.options = options;
    this.#name = resolveName(binary, options);
    this.#target = options.target ?? posix.join('/usr/local/bin', this.#name);
    this.kind = `bin:${this.#name}`;
  }

  async install(ctx: InstallerContext): Promise<void> {
    const b = shellQuote(this.binary);
    const t = shellQuote(this.#target);
    const dir = shellQuote(posix.dirname(this.#target));

    const result = await ctx.exec(
      `test -f ${b} || { echo "binary not found at ${this.binary}" >&2; exit ${NOT_FOUND_EXIT}; }; ` +
        `if ! test -x ${b}; then chmod +x ${b} || exit ${CHMOD_FAILED_EXIT}; fi; ` +
        `mkdir -p ${dir} && ln -sf ${b} ${t}`,
    );

    if (result.exitCode === 0) return;

    throw new InstallError({
      target: this.#name,
      source: 'bin',
      reason: explainFailure(result.exitCode, result.stderr, this.binary),
      containerId: ctx.containerId,
    });
  }
}

export function bin(
  binary: string,
  options?: BinInstallerOptions,
): BinInstaller {
  return new BinInstaller(binary, options);
}

function explainFailure(
  exitCode: number,
  stderr: string,
  binary: string,
): string {
  if (exitCode === NOT_FOUND_EXIT) {
    return `binary not found at ${binary}`;
  }
  if (exitCode === CHMOD_FAILED_EXIT && /read-only file system/i.test(stderr)) {
    return (
      `${binary} is not executable and the bind mount is read-only — ` +
      `run \`chmod +x\` on the host, or mount with \`readOnly: false\`. ` +
      `(${stderr.trim()})`
    );
  }
  return stderr || `bin installer failed with exit code ${exitCode}`;
}

function resolveName(binary: string, options: BinInstallerOptions): string {
  if (options.name) return options.name;
  const base = basename(binary);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
