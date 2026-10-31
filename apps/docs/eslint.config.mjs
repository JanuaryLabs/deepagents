import react from '@zukhruf/eslint/react';

import baseConfig from '../../eslint.config.mjs';

// The React preset comes first, so the root config's settings win.
export default [
  ...react,
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
