import nx from '@nx/eslint-plugin';

import baseConfig, {
  packageJsonDependencyChecks,
} from '../../../eslint.config.mjs';

// The React preset comes first, so the root config's settings win. External
// state managers are banned for every package by zukhruf/no-state-managers.
export default [
  ...nx.configs['flat/react'],
  ...baseConfig,
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
              group: ['@deepagents/agent', '@deepagents/agent/*'],
              message:
                'The React chat module consumes AI SDK and context interfaces, not an agent runtime.',
            },
          ],
        },
      ],
    },
  },
  packageJsonDependencyChecks(),
];
