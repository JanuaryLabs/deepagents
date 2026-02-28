/// <reference types='vitest' />
import sdkIt from '@sdk-it/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig(({ command }) => {
  const enableSourceMaps =
    process.env.VITE_SOURCEMAP === 'true' || process.env.SOURCEMAP === 'true';

  const babelPlugins: string[] = ['babel-plugin-react-compiler'];
  if (command === 'serve') {
    babelPlugins.push('@babel/plugin-transform-react-jsx-development');
  }

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
    plugins: [
      sdkIt('../../../.evals-sdk-it/openapi.json', {
        mode: 'full',
        output: join(__dirname, '../../../.evals-sdk-it'),
        packageName: '@evals/client',
        readme: false,
        pagination: false,
      }),
      react({
        babel: {
          plugins: babelPlugins,
        },
      }),
      tailwindcss(),
      nodePolyfills(),
    ],
    base: './',
    build: {
      outDir: './dist',
      emptyOutDir: true,
      reportCompressedSize: true,
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
