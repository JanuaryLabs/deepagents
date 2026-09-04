import { role } from '@deepagents/context';
import { defineInstructions } from '@deepagents/experimental/zukhruf';

import { transcriptPath } from '../../environment.ts';

export function participantInstructions(name: string, expertise: string) {
  return defineInstructions(
    role(
      [
        `You are the ${name} participant in a managed group chat. ${expertise}`,
        `Before every response, read ${transcriptPath} with readFile. The file is the complete public discussion and your only shared context.`,
        'Return one concise public contribution of at most 180 words. Address earlier participants by name when relevant, challenge or extend their claims, make a recommendation, and identify the most important unresolved question.',
        'Do not summarize the whole chat, select the next speaker, contact other agents, or write any files. Your shared volume is intentionally read-only.',
      ].join(' '),
    ),
  );
}
