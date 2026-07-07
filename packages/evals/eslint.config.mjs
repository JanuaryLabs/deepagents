import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs}',
            '{projectRoot}/esbuild.config.{js,ts,mjs,mts}',
            '{projectRoot}/**/*.eval.{js,jsx,ts,tsx}',
            '{projectRoot}/**/*.test.{js,jsx,ts,tsx}',
            '{projectRoot}/**/*.spec.{js,jsx,ts,tsx}',
            '{projectRoot}/src/evals/**/*.{js,jsx,ts,tsx}',
            '{projectRoot}/test/**/*.{js,jsx,ts,tsx}',
            '{projectRoot}/tests/**/*.{js,jsx,ts,tsx}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
];
