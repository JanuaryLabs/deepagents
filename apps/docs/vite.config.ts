/// <reference types='vitest' />
import { nxReadySignal } from '@nx/vite/plugins/nx-ready-signal.plugin';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import mdx from 'fumadocs-mdx/vite';
import { defineConfig } from 'vite';

import * as MdxConfig from './source.config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/docs',
  base: '/deepagents/',
  server: {
    port: 4200,
    host: 'localhost',
  },
  preview: {
    port: 4200,
    host: 'localhost',
  },
  plugins: [
    !process.env.VITEST && reactRouter(),
    tailwindcss(),
    mdx(MdxConfig),
    nxReadySignal(),
  ],
  // Uncomment this if you are using workers.
  // worker: {
  //  plugins: [ nxViteTsPaths() ],
  // },
  build: {
    outDir: './dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    sourcemap: false,
  },
  define: {
    'import.meta.vitest': undefined,
  },
}));
