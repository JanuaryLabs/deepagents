import { openai } from '@ai-sdk/openai';
import { join } from 'node:path';

import { role } from '@deepagents/context';
import { createFileTelemetry } from '@deepagents/context/telemetry/file';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import { groupChatHostDirectory, transcriptPath } from './environment.ts';
import { managerSandbox, participantSandbox } from './sandbox.ts';

function telemetry(name: string) {
  return {
    integrations: createFileTelemetry({
      append: false,
      includeTimestamp: true,
      path: join(groupChatHostDirectory, 'telemetry', `${name}.jsonl`),
    }),
  };
}

function participant(name: string, expertise: string) {
  return defineAgent({
    name,
    model: openai('gpt-5.6-luna'),
    sandbox: participantSandbox,
    telemetry: telemetry(name),
    instructions: [
      role(
        [
          `You are the ${name} participant in a managed group chat. ${expertise}`,
          `Before every response, read ${transcriptPath} with readFile. The file is the complete public discussion and your only shared context.`,
          'Return one concise public contribution of at most 180 words. Address earlier participants by name when relevant, challenge or extend their claims, make a recommendation, and identify the most important unresolved question.',
          'Do not summarize the whole chat, select the next speaker, contact other agents, or write any files. Your shared volume is intentionally read-only.',
        ].join(' '),
      ),
    ],
  });
}

const community = participant(
  'community',
  'Evaluate accessibility, likely resident feedback, equity, and usage patterns.',
);
const environment = participant(
  'environment',
  'Evaluate ecological impact, sustainability, native vegetation, and environmental constraints.',
);
const budget = participant(
  'budget',
  'Evaluate construction cost, maintenance, staffing, delivery risk, and long-term operations.',
);

export default defineAgent({
  name: 'group-chat-manager',
  model: openai('gpt-5.6-terra'),
  sandbox: managerSandbox,
  telemetry: telemetry('manager'),
  subagents: [community, environment, budget],
  instructions: [
    role(
      [
        'You are a group-chat manager, not a task-delegation supervisor. Your job is to moderate one accumulating public discussion and return its consensus.',
        `The authoritative discussion is ${transcriptPath}. Read it before every speaker decision. You are its only writer.`,
        'Available participants and fixed task paths are: community at /root/community, environment at /root/environment, and budget at /root/budget.',
        'Choose exactly one next speaker based on the most important unresolved issue in the transcript. Do not use a predetermined round-robin order and never wake multiple participants at once.',
        'Use list_agents to determine whether the selected participant exists. If absent, call spawn_agent with the matching agent_type and task_name, fork_turns set to "none", and a message telling it to read the transcript and contribute. If present, call followup_task with the fixed canonical path and the same instruction.',
        'After waking a participant, call wait_agent. If it times out, wait again; do not select another speaker while one is active.',
        'When its FINAL_ANSWER arrives, read the transcript and use writeFile to append the contribution under a heading that names the participant and contribution number. Preserve the entire existing file.',
        'Each participant must contribute at least once. After that, stop when the transcript supports a balanced recommendation with material tradeoffs and unresolved concerns, or after six total contributions.',
        'In the final answer, present the consensus, the main tradeoffs, any unresolved disagreement, and the ordered speaker list. Do not expose private delegation mechanics as if they were part of the discussion.',
      ].join(' '),
    ),
  ],
});
