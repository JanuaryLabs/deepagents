import { InstallError } from '../docker-sandbox-errors.ts';
import { Installer, type InstallerContext, shellQuote } from './installer.ts';

export interface ArchitectureUrls {
  x86_64?: string;
  aarch64?: string;
  armv7l?: string;
}

export interface UrlBinaryOptions {
  /** Final executable name installed under `/usr/local/bin`. */
  name: string;
  /** Single URL or arch-keyed map (selected via container's `uname -m`). */
  url: string | ArchitectureUrls;
  /** Path inside an extracted archive, when it differs from `name`. */
  binaryPath?: string;
}

export class UrlBinaryInstaller extends Installer {
  readonly kind: string;
  readonly options: UrlBinaryOptions;

  constructor(options: UrlBinaryOptions) {
    super();
    this.options = options;
    this.kind = `url-binary:${options.name}`;
  }

  async install(ctx: InstallerContext): Promise<void> {
    const url = await resolveUrl(ctx, this.options);
    await downloadAndInstall(
      ctx,
      this.options.name,
      url,
      this.options.binaryPath,
    );
  }
}

/**
 * Install a pre-built binary from a URL into `/usr/local/bin`.
 *
 * Supports raw binaries and `.tar.gz`/`.tgz` archives. Picks the correct
 * URL per container architecture when a map is provided. Auto-installs `curl`
 * if needed.
 *
 * @example
 * ```ts
 * urlBinary({
 *   name: 'presenterm',
 *   url: {
 *     x86_64: 'https://.../presenterm-x86_64.tar.gz',
 *     aarch64: 'https://.../presenterm-aarch64.tar.gz',
 *   },
 * });
 * ```
 */
export function urlBinary(options: UrlBinaryOptions): UrlBinaryInstaller {
  return new UrlBinaryInstaller(options);
}

async function resolveUrl(
  ctx: InstallerContext,
  options: UrlBinaryOptions,
): Promise<string> {
  if (typeof options.url === 'string') return options.url;

  const arch = await ctx.arch();
  const archUrl = options.url[arch as keyof ArchitectureUrls];
  if (!archUrl) {
    throw new InstallError({
      target: options.name,
      source: 'url',
      reason: `No URL provided for architecture "${arch}". Available: ${Object.keys(options.url).join(', ')}`,
      containerId: ctx.containerId,
    });
  }
  return archUrl;
}

export async function downloadAndInstall(
  ctx: InstallerContext,
  name: string,
  url: string,
  binaryPath?: string,
  source: 'url' | 'github-release' = 'url',
): Promise<void> {
  await ctx.ensureTool('curl');

  const isTarGz = url.endsWith('.tar.gz') || url.endsWith('.tgz');
  const installCmd = isTarGz
    ? buildTarGzInstallCmd(name, url, binaryPath ?? name)
    : buildRawInstallCmd(name, url);

  const result = await ctx.exec(installCmd);
  if (result.exitCode !== 0) {
    throw new InstallError({
      target: name,
      source,
      url,
      reason: result.stderr,
      containerId: ctx.containerId,
    });
  }
}

function buildTarGzInstallCmd(
  name: string,
  url: string,
  binaryPathInArchive: string,
): string {
  return `
    set -e
    NAME=${shellQuote(name)}
    URL=${shellQuote(url)}
    BIN_IN_ARCHIVE=${shellQuote(binaryPathInArchive)}
    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    curl -fsSL "$URL" -o archive.tar.gz
    tar -xzf archive.tar.gz
    BINARY_FILE=$(find . -name "$BIN_IN_ARCHIVE" -o -name "$NAME" | head -1)
    if [ -z "$BINARY_FILE" ]; then
      echo "Binary not found in archive. Contents:" >&2
      find . -type f >&2
      exit 1
    fi
    chmod +x "$BINARY_FILE"
    mv "$BINARY_FILE" "/usr/local/bin/$NAME"
    cd /
    rm -rf "$TMPDIR"
  `;
}

function buildRawInstallCmd(name: string, url: string): string {
  return `
    NAME=${shellQuote(name)}
    URL=${shellQuote(url)}
    curl -fsSL "$URL" -o "/usr/local/bin/$NAME"
    chmod +x "/usr/local/bin/$NAME"
  `;
}
