import { Installer, type InstallerContext } from './installer.ts';

export class PackageInstaller extends Installer {
  readonly kind: string;
  readonly packages: readonly string[];

  constructor(packages: readonly string[]) {
    super();
    this.packages = packages;
    this.kind =
      packages.length === 0 ? 'pkg:<empty>' : `pkg:${packages.join(',')}`;
  }

  async install(ctx: InstallerContext): Promise<void> {
    if (this.packages.length === 0) return;
    await ctx.installPackages([...this.packages]);
  }
}

/**
 * Install OS packages via the container's native package manager.
 *
 * Auto-detects `apk` (Alpine) vs `apt-get` (Debian/Ubuntu/Node/Python images).
 *
 * @example
 * ```ts
 * createDockerSandbox({ installers: [pkg(['curl', 'jq'])] });
 * ```
 */
export function pkg(packages: readonly string[]): PackageInstaller {
  return new PackageInstaller(packages);
}
