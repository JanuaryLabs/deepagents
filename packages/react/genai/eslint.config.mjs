import nx from '@nx/eslint-plugin';

import baseConfig from '../../../eslint.config.mjs';

export default [
  ...baseConfig,
  ...nx.configs['flat/react'],
  {
    settings: { react: { version: '19' } },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'zustand',
                'zustand/*',
                'jotai',
                'jotai/*',
                'redux',
                '@reduxjs/toolkit',
                'react-redux',
                'mobx',
                'mobx-react',
              ],
              message:
                'Keep shared chat state inside React context, server-state modules, or host-owned adapters.',
            },
            {
              group: ['@deepagents/agent', '@deepagents/agent/*'],
              message:
                'The React chat module consumes AI SDK and context interfaces, not an agent runtime.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs}',
            '{projectRoot}/vite.config.{js,ts,mjs,mts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
