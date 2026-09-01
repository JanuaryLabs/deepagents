import baseConfig, {
  packageJsonDependencyChecks,
} from '../../eslint.config.mjs';

export default [...baseConfig, packageJsonDependencyChecks];
