import nx from '@nx/eslint-plugin';

import baseConfig, {
  packageJsonDependencyChecks,
} from '../../eslint.config.mjs';

const [severity, options] =
  packageJsonDependencyChecks.rules['@nx/dependency-checks'];

export default [
  ...baseConfig,
  ...nx.configs['flat/react'],
  {
    files: ['ui/src/components/ui/**/*.{ts,tsx}', 'ui/src/hooks/use-mobile.ts'],
    rules: {
      eqeqeq: 'off',
      'jsx-a11y/anchor-has-content': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    ...packageJsonDependencyChecks,
    rules: {
      '@nx/dependency-checks': [
        severity,
        {
          ...options,
          ignoredFiles: [
            '{projectRoot}/ui/src/**/*.{ts,tsx}',
            '{projectRoot}/ui/vite.config.ts',
          ],
        },
      ],
    },
  },
];
