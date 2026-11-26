/// <reference types="vitest" />
import { nxReadySignal } from '@nx/vite/plugins/nx-ready-signal.plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss(), nxReadySignal()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
  },
  test: {
    name: '@deepagents/devtool-ui',
    watch: false,
    environment: 'happy-dom',
    include: ['src/routes/**/*.{test,spec}.{ts,tsx}'],
  },
});
