import zukhruf from '@zukhruf/eslint';
import react from '@zukhruf/eslint/react';

import baseConfig from '../../eslint.config.mjs';

// The React preset comes first, so the root config's settings win.
export default [
  ...react,
  ...baseConfig,
  ...zukhruf.configs['react-router'],
  {
    ignores: ['.source/**'],
  },
];
