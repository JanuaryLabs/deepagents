import { defineConfig } from 'evalite/config';
import { createSqliteStorage } from 'evalite/sqlite-storage';

export default defineConfig({
  maxConcurrency: 1, // Run one test at a time
  testTimeout: 60000, // Increase timeout for LLM calls (60 seconds)
  storage: () => createSqliteStorage('evalite.sqlite'),
});
