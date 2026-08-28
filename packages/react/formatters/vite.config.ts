/// <reference types="vitest" />
import path from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/packages/react/formatters',
  plugins: [
    dts({
      entryRoot: 'src',
      tsconfigPath: path.join(import.meta.dirname, 'tsconfig.lib.json'),
    }),
  ],
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      name: '@deepagents/react-formatters',
      fileName: 'index',
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
    },
  },
  test: {
    name: '@deepagents/react-formatters',
    watch: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/junit.xml' },
    coverage: { reportsDirectory: './test-results' },
  },
}));
