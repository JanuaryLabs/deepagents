import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  ...nx.configs['flat/react'],
  {
    ignores: ['.source/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
  {
    files: ['app/routes/docs.tsx'],
    rules: {
      // fumadocs clientLoader.getComponent() dynamically creates components by design
      'react-hooks/static-components': 'off',
    },
  },
];
