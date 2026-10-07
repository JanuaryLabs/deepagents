import nx from '@nx/eslint-plugin';
import zukhruf from '@zukhruf/eslint';
import { dependencyPolicy, moduleBoundaries } from '@zukhruf/eslint/nx';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const jsonc = await import('jsonc-eslint-parser');

const packagesDir = join(import.meta.dirname, 'packages');
const privatePackages = [];
for (const dir of readdirSync(packagesDir)) {
  const packageJsonPath = join(packagesDir, dir, 'package.json');
  if (!existsSync(packageJsonPath)) continue;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.private) privatePackages.push(packageJson.name);

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

/**
 * Shared package.json dependency validation for publishable packages. The
 * checked file set is each project's build inputs (`production` in nx.json),
 * which already leaves out tests and evals. Private workspace packages
 * (resolved via workspace symlinks) must never be written into a package.json,
 * so the fixer is told to ignore them. Arguments are further packages the
 * check ignores in that project.
 */
export const packageJsonDependencyChecks = (...ignoredDependencies) => ({
  files: ['**/*.json'],
  rules: {
    '@nx/dependency-checks': [
      'error',
      dependencyPolicy({
        ignoredDependencies: [...privatePackages, ...ignoredDependencies],
      }),
    ],
  },
  languageOptions: { parser: jsonc },
});

const typescript = ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'];
const source = [...typescript, '**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'];
const tests = ['**/*.{test,spec}.{ts,tsx,cts,mts,js,jsx,cjs,mjs}'];

export default defineConfig(
  nx.configs['flat/base'],
  {
    ignores: [
      '**/dist',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
      '**/build',
      '**/.react-router',
      '**/.venv',
    ],
  },
  {
    plugins: { zukhruf },
    extends: ['zukhruf/base', 'zukhruf/tests', 'zukhruf/react'],
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
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.test.js',
      '**/*.test.jsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.spec.js',
      '**/*.spec.jsx',
      '**/*.fixture.ts',
      '**/*.fixture.tsx',
      '**/*.fixture.js',
      '**/*.fixture.jsx',
      '**/test/**/*.ts',
      '**/test/**/*.tsx',
      '**/test/**/*.js',
      '**/test/**/*.jsx',
      '**/tests/**/*.ts',
      '**/tests/**/*.tsx',
      '**/tests/**/*.js',
      '**/tests/**/*.jsx',
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
      'zukhruf/no-enum': 'warn',
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
    rules: {
      'zukhruf/no-test-lifecycle-hooks': 'warn',
      'zukhruf/require-msw-error-on-unhandled-request': 'warn',
    },
  },
  prettier,
);
