import baseConfig, {
  packageJsonDependencyChecks,
} from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  // xlsx installs from the SheetJS CDN tarball, since npm stops at 0.18.5. The
  // check compares only semver, file:, workspace: and * specifiers, so it flags
  // the URL, and its fix would write "0.20.3", which npm cannot install.
  packageJsonDependencyChecks('xlsx'),
];
