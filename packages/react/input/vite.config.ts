/// <reference types="vitest" />
import babel from '@rolldown/plugin-babel';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/packages/react/input',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(import.meta.dirname, 'tsconfig.lib.json'),
    }),
  ],
  oxc: { jsx: { development: false } },
  assetsInclude: ['**/*.css'],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    sourcemap: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
    lib: {
      entry: {
        index: 'src/index.ts',
        browser: 'src/browser.ts',
      },
      name: '@deepagents/react-input',
      formats: ['es' as const],
    },
    rolldownOptions: {
      external: (id) =>
        id.startsWith('node:') ||
        !(
          id.startsWith('.') ||
          path.isAbsolute(id) ||
          id.startsWith('\0') ||
          id.includes(':')
        ),
      output: {
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  test: {
    name: '@deepagents/react-input',
    watch: false,
    globals: true,
    environment: 'happy-dom',
    // Built workspace packages have no source tsconfig and run directly in Node.
    server: { deps: { external: [/\/dist\//] } },
    pool: 'forks',
    execArgv: ['--no-experimental-webstorage'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/junit.xml' },
    coverage: { reportsDirectory: './test-results' },
  },
}));
