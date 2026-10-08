import nx from '@nx/eslint-plugin';
import zukhruf from '@zukhruf/eslint';
import { manifest, moduleBoundaries } from '@zukhruf/eslint/nx';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const packagesDir = join(import.meta.dirname, 'packages');
for (const dir of readdirSync(packagesDir)) {
  const packageJsonPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(packageJsonPath)) continue;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  const projectJsonPath = join(packagesDir, dir, 'project.json');
  const tags = existsSync(projectJsonPath)
    ? (JSON.parse(readFileSync(projectJsonPath, 'utf8')).tags ?? [])
    : (packageJson.nx?.tags ?? []);
  const expectedTag = packageJson.private ? 'scope:private' : 'scope:public';
  if (!tags.includes(expectedTag)) {
    throw new Error(
      `packages/${dir} must be tagged "${expectedTag}" to match the "private" flag in its package.json (module-boundary constraints depend on it).`,
    );
  }
}

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
              sourceTag: 'scope:public',
              onlyDependOnLibsWithTags: ['scope:public'],
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
      '@typescript-eslint/switch-exhaustiveness-check': 'warn',
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
