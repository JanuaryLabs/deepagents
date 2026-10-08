import nx from '@nx/eslint-plugin';

import baseConfig from '../../../eslint.config.mjs';

// The React preset comes first, so the root config's settings win.
export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    // Copied Shadcn registry files: keep them updateable without local rewrites.
    files: ['ui/src/components/ui/**/*.{ts,tsx}', 'ui/src/hooks/use-mobile.ts'],
    rules: {
      eqeqeq: 'off',
      'jsx-a11y/anchor-has-content': 'off',
      'react-hooks/set-state-in-effect': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
];
