import { type Tool } from 'ai';
import { writeFile } from 'node:fs/promises';

import {
  type Agent,
  type AgentModel,
  type Instruction,
  agent,
  instructions,
} from '../agent.ts';
import { glm } from '../models.ts';
import { printer } from '../stream_utils.ts';
import { execute, swarm } from '../swarm.ts';

export function createSupervisor<C>(props: {
  prompt: Instruction<C>;
  subagents: Agent<C>[];
  name?: string;
  model?: AgentModel;
  outputMode?: 'full_history' | 'last_message';
  handoffDescription?: string;
  tools?: Record<string, Tool>;
}) {
  const subagents = props.subagents.map((subagent) =>
    subagent.clone({ model: subagent.model || props.model }),
  );
  const supervisor: Agent<C> = agent<C>({
    name: props.name || 'supervisor',
    model: props.model,
    prompt: props.prompt,
    handoffs: subagents,
    tools: props.tools,
    handoffDescription:
      props.handoffDescription ??
      `A helpful agent that supervises and coordinates multiple specialized sub-agents to accomplish complex tasks.`,
    prepareHandoff(messages) {
      // console.dir({ supervisor: messages }, { depth: null });
      // for (const message of messages) {
      //   if (message.role === 'assistant') {
      //     if (Array.isArray(message.content)) {
      //       for (const block of message.content) {
      //         if (block.type === 'text') {
      //           block.text = `<name></name><content>${block.text}</content>`;
      //         }
      //       }
      //     }
      //   }
      // }
    },
    prepareEnd({ messages, contextVariables, abortSignal, responseMessage }) {
      const state = contextVariables as any;
      console.log('supervisor: Falling back to supervisor', state);
      if (state.currentActiveAgent === undefined) {
        console.warn(
          `supervisor: active agent was never set, so supervisor responded directly`,
        );
        // active agent was never set, so supervisor responded directly
        return void 0;
      }
      if (state.currentActiveAgent === supervisor.internalName) {
        // TODO: this condition should be implict in the swarm function (if the same agent ended the conversation that means loop completed).
        console.warn(
          `supervisor: active agent is supervisor, so supervisor responded directly`,
        );
        // active agent is supervisor, so supervisor responded directly
        return void 0;
      }
      state.currentActiveAgent = supervisor.internalName;
      // responseMessage.parts.push({
      //   type: 'dynamic-tool',
      //   toolName: supervisor.handoffToolName,
      //   toolCallId: crypto.randomUUID(),
      //   state: 'output-available',
      //   input: {},
      //   output: `Transfer successful.`,
      // });
      const lastMessage = messages.at(-1);
      if (!lastMessage) {
        throw new Error('No messages found');
      }
      lastMessage.parts.push({
        type: 'dynamic-tool',
        toolName: supervisor.handoffToolName,
        state: 'output-available',
        toolCallId: crypto.randomUUID(),
        input: {},
        output: `Transfer successful to ${this.name}`,
      });
      return execute<C>(
        supervisor,
        messages,
        contextVariables,
        supervisor.instructions(contextVariables),
        { abortSignal },
      );
    },
  });
  for (const subagent of subagents) {
    subagent.handoffs.unshift(supervisor);
  }
  return supervisor;
}

const writer = agent({
  name: 'writer_agent',
  model: glm('glm-4.5-Flash'),
  prompt: instructions({
    purpose: [
      'You are a professional writer who creates clear, engaging content.',
      'You excel at turning information into well-structured articles, summaries, and reports.',
    ],
    routine: [
      'Write in a clear, professional tone',
      'Structure content with proper headings and paragraphs',
      'Make complex information accessible to readers',
    ],
  }),
  handoffDescription:
    'Use this agent to create professional written content and documentation.',
});

const critique = agent({
  name: 'critique_agent',
  model: glm('glm-4.5'),
  prompt: instructions({
    purpose: [
      'You are a critical analyst who provides thorough critique and evaluation.',
      'You examine content from multiple angles and offer detailed constructive criticism.',
    ],
    routine: [
      'Analyze content critically and objectively',
      'Identify strengths and weaknesses',
      'Provide detailed constructive criticism',
      'Suggest specific improvements and alternatives',
      'Consider different perspectives and viewpoints',
    ],
  }),
  handoffDescription:
    'Use this agent to provide detailed critique and critical analysis.',
});

const supervisor = createSupervisor({
  model: glm('glm-4.5-Flash'),
  subagents: [writer, critique],
  outputMode: 'last_message',
  prompt: instructions({
    purpose: [
      'You are a content manager coordinating between a writer and critic.',
      'You do not do any writing or critiquing yourself. Do not update the writing based on critique yourself. handoff to the appropriate agent.',
    ],
    routine: [
      'Determine if content needs writing or critiquing',
      'if writer finished, send to critique',
      'Deliver polished final results to the user',
    ],
  }),
});

if (import.meta.main) {
  const stream = swarm(
    supervisor,
    `A reflection on the quiet art of living alone.`,
    { currentActiveAgent: supervisor.internalName },
  );
  printer.readableStream(stream);
}
