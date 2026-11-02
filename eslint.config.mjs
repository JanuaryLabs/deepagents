import nx from '@nx/eslint-plugin';
import zukhruf, { noUnassignedImport } from '@zukhruf/eslint';
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
      'zukhruf/hono',
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
      // A probe script runs the built package through its public entrypoints.
      '**/scripts/probe-*.ts',
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
      // node:sqlite's tag store runs a statement as a tagged template, and a
      // write such as sql.run`DELETE ...` often has no result to use.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowTaggedTemplates: true },
      ],
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // @zukhruf/eslint's base turns these off; they were warnings here
      // before the move, and stay warnings.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Base allows *.css, env.ts and startup.ts. Loading these too is the
      // point of importing them: Sass stylesheets, and jest-dom's vitest
      // entry, which registers its matchers.
      'import-x/no-unassigned-import': [
        'error',
        noUnassignedImport({
          allow: ['**/*.{scss,sass}', '@testing-library/jest-dom/vitest'],
        }),
      ],
    },
  },
  prettier,
);
