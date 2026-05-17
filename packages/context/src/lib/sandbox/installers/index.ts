export {
  Installer,
  type InstallerContext,
  type PackageManager,
  createInstallerContext,
  isDebianBased,
  shellQuote,
} from './installer.ts';

export { PackageInstaller, pkg } from './package-manager.ts';
export {
  type ArchitectureUrls,
  type UrlBinaryOptions,
  UrlBinaryInstaller,
  urlBinary,
} from './url-binary.ts';
export { type NpmInstallerOptions, NpmInstaller, npm } from './npm.ts';
export { type BinInstallerOptions, BinInstaller, bin } from './bin.ts';
export { type PipInstallerOptions, PipInstaller, pip } from './pip.ts';
export {
  type GithubReleaseOptions,
  GithubReleaseInstaller,
  githubRelease,
} from './github-release.ts';
