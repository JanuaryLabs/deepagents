import { defineConfig } from 'evalite/config';

const trialCount = process.env.EVALITE_TRIAL_COUNT
  ? Number.parseInt(process.env.EVALITE_TRIAL_COUNT)
  : 1;
export default defineConfig({
  trialCount,
  testTimeout: 60000, // Increase timeout for LLM calls (60 seconds)
  maxConcurrency: 16,
});
