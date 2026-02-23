import build from '@hono/vite-build/node';
import devServer from '@hono/vite-dev-server';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Plugin, defineConfig, loadEnv } from 'vite';

const root = import.meta.dirname;
const monorepoRoot = resolve(root, '../../../../..');

function rawTextPlugin(extensions: string[]): Plugin {
  return {
    name: 'raw-text',
    transform(_code, id) {
      if (extensions.some((ext) => id.endsWith(ext))) {
        const content = readFileSync(id, 'utf-8');
        return {
          code: `export default ${JSON.stringify(content)};`,
          map: null,
        };
      }
    },
  };
}

export default defineConfig(({ command, isSsrBuild, mode }) => {
  const rawText = rawTextPlugin(['.sql', '.txt']);
  const env = loadEnv(mode, monorepoRoot, '');
  Object.assign(process.env, env);

  if (command === 'serve') {
    return {
      root,
      plugins: [rawText, devServer({ entry: './index.tsx' }), tailwindcss()],
    };
  }

  if (!isSsrBuild) {
    return {
      root,
      build: {
        outDir: resolve(root, 'dist'),
        rollupOptions: {
          input: [resolve(root, 'styles.css')],
          output: { assetFileNames: 'assets/[name].[ext]' },
        },
        copyPublicDir: false,
      },
      plugins: [tailwindcss()],
    };
  }

  return {
    root,
    plugins: [
      rawText,
      build({
        entry: './index.tsx',
        output: 'index.js',
        outputDir: resolve(root, 'dist'),
        port: 3005,
        minify: false,
        emptyOutDir: false,
      }),
      tailwindcss(),
    ],
  };
});
