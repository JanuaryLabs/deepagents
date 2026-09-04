import { join } from 'node:path';

import { createFileTelemetry } from '@deepagents/context/telemetry/file';

import { groupChatHostDirectory } from './environment.ts';

export function telemetry(name: string) {
  return {
    integrations: createFileTelemetry({
      append: false,
      includeTimestamp: true,
      path: join(groupChatHostDirectory, 'telemetry', `${name}.jsonl`),
    }),
  };
}
