import nx from '@nx/eslint-plugin';

import baseConfig from '../../eslint.config.mjs';

// The React preset comes first, so the root config's settings win.
export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
  {
    ignores: ['.source/**'],
  },
  {
    files: ['app/routes/docs.tsx'],
    rules: {
      // fumadocs clientLoader.getComponent() dynamically creates components by design
      'react-hooks/static-components': 'off',
    },
  },
];
