import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export const groupChatRunId = randomUUID();
export const groupChatDirectory = '/group-chat';
export const transcriptPath = `${groupChatDirectory}/transcript.md`;
export const groupChatHostDirectory = join(
  realpathSync(import.meta.dirname),
  '.runtime',
  groupChatRunId,
);
export const hostTranscriptPath = join(groupChatHostDirectory, 'transcript.md');
export const sandboxRunLabel = 'deepagents-group-chat-run';
