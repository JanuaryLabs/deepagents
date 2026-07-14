import nx from '@nx/eslint-plugin';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
 * Shared package.json dependency validation for publishable packages.
 * The checked file set is the build target's `production` inputs (nx.json),
 * which already excludes test and eval files. Private workspace packages
 * (resolved via workspace symlinks) must never be written into a
 * package.json, so the fixer is told to ignore them.
 */
export const packageJsonDependencyChecks = {
  files: ['**/*.json'],
  rules: {
    '@nx/dependency-checks': [
      'error',
      {
        ignoredDependencies: privatePackages,
      },
    ],
  },
  languageOptions: {
    parser: await import('jsonc-eslint-parser'),
  },
};

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
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
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      'no-unused-private-class-members': 'off',
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?js$'],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
            {
              sourceTag: 'scope:public',
              onlyDependOnLibsWithTags: ['scope:public'],
            },
          ],
        },
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
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
