import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { AgentRuntime, renderTurn } from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';
import {
  groupChatHostDirectory,
  groupChatRunId,
  hostTranscriptPath,
  transcriptPath,
} from './environment.ts';
import stack from './stack.ts';

const proposal =
  'Evaluate a proposal for a new neighborhood park with a playground, a small wetland boardwalk, and an events lawn. The capital budget is $2 million.';

await mkdir(groupChatHostDirectory, { recursive: true });
await writeFile(
  hostTranscriptPath,
  [
    '# Park proposal group chat',
    '',
    '## Objective',
    '',
    'Reach a balanced recommendation that accounts for community, environmental, and budget concerns.',
    '',
    '## Proposal from the user',
    '',
    proposal,
    '',
    '## Public discussion',
    '',
  ].join('\n'),
);

const runtime = new AgentRuntime(declaration);
await using host = await runtime.initialize(stack);

await using worker = await host.work({ concurrency: 4 });
const conversation = {
  chatId: `group-chat-${groupChatRunId}`,
  userId: process.env.USER ?? 'local',
};
const turn = await host.enqueue(conversation, {
  message: {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Moderate the proposal discussion. Select each next speaker, maintain the public transcript, and return the final consensus.',
      },
    ],
  },
  trigger: 'submit-message',
});

await renderTurn(turn.stream);
const status = await host.observe(conversation).status(turn.id);
if (status?.status === 'failed') {
  throw new Error(status.error ?? 'Group chat turn failed');
}
console.log(
  `\n\n--- shared transcript (${hostTranscriptPath}, mounted at ${transcriptPath}) ---\n${await readFile(hostTranscriptPath, 'utf8')}`,
);
