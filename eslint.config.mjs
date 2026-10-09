import nx from '@nx/eslint-plugin';
import zukhruf from '@zukhruf/eslint';
import { manifest, moduleBoundaries } from '@zukhruf/eslint/nx';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';

const typescript = ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'];
const source = [...typescript, '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'];
const tests = ['**/*.{test,spec}.{ts,tsx,cts,mts,js,jsx,cjs,mjs}'];

export default defineConfig(
  nx.configs['flat/base'],
  { ignores: ['**/.venv'] },
  {
    plugins: { zukhruf, manifest },
    extends: [
      'zukhruf/base',
      'zukhruf/tests',
      'zukhruf/react',
      'manifest/recommended',
    ],
  },
  {
    files: ['**/package.json'],
    rules: {
      'manifest/dependency-checks': [
        'error',
        {
          projects: {
            // xlsx installs from the SheetJS CDN tarball, since npm stops at
            // 0.18.5. The check compares only semver, file:, workspace: and *
            // specifiers, so it flags the URL, and its fix would write
            // "0.20.3", which npm cannot install.
            'packages/text2sql': { ignoredDependencies: ['xlsx'] },
          },
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        moduleBoundaries({
          depConstraints: [
            {
              sourceTag: 'npm:public',
              onlyDependOnLibsWithTags: ['npm:public'],
            },
          ],
        }),
      ],
    },
  },
  {
    files: [
      '**/*.eval.ts',
      '**/*.{test,spec,fixture}.{ts,tsx,js,jsx}',
      '**/{test,tests}/**/*.{ts,tsx,js,jsx}',
    ],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
  {
    files: source,
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { ignoreUsingDeclarations: true },
      ],
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // @zukhruf/eslint's base turns these off; they were warnings here
      // before the move, and stay warnings.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Loading these modules is the point of importing them: stylesheets,
      // env.ts / startup.ts modules that set up the process on load, and
      // jest-dom's vitest entry, which registers its matchers.
      'import-x/no-unassigned-import': [
        'error',
        {
          allow: [
            '**/*.{css,scss,sass}',
            '**/env.ts',
            '**/startup.ts',
            '@testing-library/jest-dom/vitest',
          ],
        },
      ],
    },
  },
  {
    // A React Router route module throws a Response (or data()) to show an
    // error page, such as a 404; a returned one would render as data.
    files: ['**/app/routes/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'lib', name: 'Response' },
            {
              from: 'package',
              package: 'react-router',
              name: 'DataWithResponseInit',
            },
          ],
        },
      ],
    },
  },
  // Transient: these checks are new here and have findings that the next
  // commits fix package by package. Each line goes when its findings are gone;
  // the last commit removes the block. A severity alone keeps the options
  // @zukhruf/eslint gave the rule.
  {
    files: typescript,
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/only-throw-error': 'warn',
      'zukhruf/no-enum': 'warn',
      'zukhruf/no-phase-flag': 'warn',
      'zukhruf/no-promise-field': 'warn',
    },
  },
  {
    files: source,
    rules: {
      '@typescript-eslint/parameter-properties': 'warn',
      'import-x/no-duplicates': 'warn',
      'import-x/no-unassigned-import': 'warn',
    },
  },
  {
    files: typescript,
    ignores: [...tests, '**/*.fixture.ts'],
    rules: { 'functional/no-let': 'warn' },
  },
  {
    files: tests,
    rules: { 'zukhruf/no-test-lifecycle-hooks': 'warn' },
  },
  prettier,
);
