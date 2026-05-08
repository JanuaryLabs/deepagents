import { Installer, type InstallerContext } from './installer.ts';
import { downloadAndInstall } from './url-binary.ts';

export interface GithubReleaseOptions {
  /** GitHub owner (user or org). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Release tag (e.g. `'v0.15.1'`). */
  version: string;
  /** Final executable name installed under `/usr/local/bin`. */
  name: string;
  /**
   * Build the asset filename for a given container architecture
   * (the result of `uname -m`, e.g. `'x86_64'`, `'aarch64'`).
   *
   * @example
   * ```ts
   * asset: (arch) => `presenterm-0.15.1-${arch}-unknown-linux-musl.tar.gz`
   * ```
   */
  asset: (arch: string) => string;
  /** Path inside an extracted archive, when it differs from `name`. */
  binaryPath?: string;
}

export class GithubReleaseInstaller extends Installer {
  readonly kind: string;
  readonly options: GithubReleaseOptions;

  constructor(options: GithubReleaseOptions) {
    super();
    this.options = options;
    this.kind = `github-release:${options.owner}/${options.repo}@${options.version}`;
  }

  async install(ctx: InstallerContext): Promise<void> {
    const arch = await ctx.arch();
    const assetName = this.options.asset(arch);
    const url =
      `https://github.com/${this.options.owner}/${this.options.repo}` +
      `/releases/download/${this.options.version}/${assetName}`;

    await downloadAndInstall(
      ctx,
      this.options.name,
      url,
      this.options.binaryPath,
      'github-release',
    );
  }
}

/**
 * Install a binary from a GitHub release. Resolves arch-specific assets
 * via the `asset(arch)` callback.
 *
 * @example
 * ```ts
 * githubRelease({
 *   owner: 'mfontanini',
 *   repo: 'presenterm',
 *   version: 'v0.15.1',
 *   name: 'presenterm',
 *   asset: (arch) => `presenterm-0.15.1-${arch}-unknown-linux-musl.tar.gz`,
 * });
 * ```
 */
export function githubRelease(
  options: GithubReleaseOptions,
): GithubReleaseInstaller {
  return new GithubReleaseInstaller(options);
}
