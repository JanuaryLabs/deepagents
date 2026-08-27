import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@deepagents/chat-input',
    watch: false,
    globals: true,
    environment: 'happy-dom',
    pool: 'forks',
    execArgv: ['--no-experimental-webstorage'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../test-results/chat-input.xml' },
  },
});
