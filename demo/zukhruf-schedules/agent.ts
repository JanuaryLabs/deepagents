import { openai } from '@ai-sdk/openai';
import { InMemoryFs } from 'just-bash';

import { createVirtualSandbox, role } from '@deepagents/context';
import { defineAgent, defineSandbox } from '@deepagents/experimental/zukhruf';
import { schedules } from '@deepagents/experimental/zukhruf/schedules';

/**
 * Tasks are managed from the DevTool, so no `scheduleFiles()` source is
 * installed: file declarations reassert themselves on every start, which would
 * silently revert a browser edit and refuse to boot after a browser archive.
 */
export const scheduled = schedules({
  queue: 'scheduled-tasks',
  reconciliationIntervalMs: 5_000,
  workerOptions: { pollingIntervalSeconds: 0.5 },
});

export default defineAgent({
  name: 'scheduled-assistant',
  model: openai('gpt-5.6-luna'),
  sandbox: defineSandbox(() =>
    createVirtualSandbox({ fs: new InMemoryFs(), javascript: true }),
  ),
  instructions: [
    role('Complete scheduled work autonomously and return a concise result.'),
  ],
  plugins: [scheduled],
});
