/// <reference types='vitest' />
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const enableSourceMaps =
    process.env.VITE_SOURCEMAP === 'true' || process.env.SOURCEMAP === 'true';

  return {
    root: __dirname,
    cacheDir: '../../../node_modules/.vite/apps/evals-web-runner/frontend',
    server: {
      port: 5173,
      host: 'localhost',
      proxy: {
        '/api': {
          target: 'http://localhost:8009',
          changeOrigin: true,
        },
      },
    },
    define: {
      'process.env': {},
    },
    resolve: {
      alias: {
        '@evals/client': resolve(
          __dirname,
          '../../../.evals-sdk-it/src/index.ts',
        ),
      },
    },
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ],
    base: './',
    build: {
      outDir: './dist',
      emptyOutDir: true,
      reportCompressedSize: true,
      chunkSizeWarningLimit: 600,
      sourcemap: enableSourceMaps,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    test: {
      name: 'frontend',
      watch: false,
      globals: true,
      environment: 'jsdom',
      include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      reporters: ['default'],
      coverage: {
        reportsDirectory: './test-output/vitest/coverage',
        provider: 'v8' as const,
      },
    },
  };
});
