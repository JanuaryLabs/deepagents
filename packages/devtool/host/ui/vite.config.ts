/// <reference types="vitest" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
  },
  test: {
    name: '@deepagents/devtool-ui',
    watch: false,
    globals: true,
    environment: 'happy-dom',
    include: ['src/routes/**/*.{test,spec}.{ts,tsx}'],
  },
});
