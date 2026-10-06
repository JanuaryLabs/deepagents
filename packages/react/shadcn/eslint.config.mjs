import nx from '@nx/eslint-plugin';

import baseConfig, {
  packageJsonDependencyChecks,
} from '../../../eslint.config.mjs';

// The React preset comes first, so the root config's settings win.
export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    settings: { react: { version: '19' } },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Keep upstream Shadcn registry files updateable without local rewrites.
    rules: {
      eqeqeq: 'off',
      'jsx-a11y/anchor-has-content': 'off',
      'react-hooks/set-state-in-effect': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
  packageJsonDependencyChecks(),
];
