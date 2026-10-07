import {
  type GenerateTextResult,
  type ModelMessage,
  Output,
  type PrepareStepFunction,
  type PrepareStepResult,
  type StreamTextResult,
  type StreamTextTransform,
  type Tool,
  type ToolSet,
  type UIDataTypes,
  type UIMessage,
  type UIMessagePart,
  type UITools,
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  generateText,
  isStepCount,
  smoothStream,
  streamText,
  toUIMessageStream,
} from 'ai';
import chalk from 'chalk';

import { type Agent, type AgentModel, type AgentOutput } from './agent.ts';
import {
  last,
  messageToUiMessage,
  toToolsContext,
  user,
} from './stream_utils.ts';

/**
 * Handoff state the swarm keeps on the context variables: a transfer tool
 * writes the agent it hands off to, and prepareStep reads it on the next step.
 */
export type SwarmContext = { currentActiveAgent?: string };

/**
 * An agent's tools as the swarm runs them: every tool receives the swarm's
 * context variables. Input and output stay `any`, as in the SDK's ToolSet.
 */
export type SwarmToolSet = Record<string, Tool<any, any, SwarmContext>>;

export type OutputMode = 'full_history' | 'last_message';

export interface ExecuteOptions {
  contextVariables?: Record<string, unknown>;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  outputMode?: OutputMode;
}

export async function generate<O, CIn, COut = CIn>(
  agent: Agent<O, CIn, COut>,
  messages: UIMessage[] | string,
  contextVariables: CIn & SwarmContext,
  config?: {
    abortSignal?: AbortSignal;
    providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  },
): Promise<GenerateTextResult<ToolSet, any, AgentOutput<O>>> {
  const tools: SwarmToolSet = agent.toToolset();
  return generateText({
    abortSignal: config?.abortSignal,
    providerOptions: agent.providerOptions ?? config?.providerOptions,
    model: agent.model,
    instructions: agent.instructions(contextVariables),
    messages: await convertToModelMessages(
      Array.isArray(messages) ? messages : [user(messages)],
      { ignoreIncompleteToolCalls: true, tools },
    ),
    repairToolCall: agent.repairToolCall(config?.abortSignal),
    stopWhen: isStepCount(25),
    tools,
    activeTools: agent.toolsNames,
    runtimeContext: contextVariables,
    toolsContext: toToolsContext(tools, contextVariables),
    toolChoice: agent.toolChoice,
    output: agent.output ? Output.object({ schema: agent.output }) : undefined,
    onToolExecutionStart: ({ toolCall }) => {
      console.log(
        `Debug: ${chalk.yellow('ToolCalled')}: ${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
      );
    },
    prepareStep: prepareStep(agent, agent.model, contextVariables),
    // onEnd: (result) => {
    //   (contextVariables as any).content = result.content;
    // },
  });
}

export async function execute<O, CIn, COut = CIn>(
  agent: Agent<O, CIn, COut>,
  messages: UIMessage[] | string,
  contextVariables: CIn & SwarmContext,
  config?: {
    abortSignal?: AbortSignal;
    providerOptions?: Parameters<typeof streamText>[0]['providerOptions'];
    transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
  },
): Promise<StreamTextResult<ToolSet, any, AgentOutput<O>>> {
  const runId = generateId();
  const tools: SwarmToolSet = agent.toToolset();
  const stream = streamText({
    abortSignal: config?.abortSignal,
    providerOptions: config?.providerOptions,
    model: agent.model,
    instructions: agent.instructions(contextVariables),
    messages: await convertToModelMessages(
      Array.isArray(messages) ? messages : [user(messages)],
      { ignoreIncompleteToolCalls: true, tools },
    ),
    stopWhen: isStepCount(25),
    experimental_transform: config?.transform ?? smoothStream(),
    tools,
    activeTools: agent.toolsNames,
    runtimeContext: contextVariables,
    toolsContext: toToolsContext(tools, contextVariables),
    toolChoice: agent.toolChoice,
    repairToolCall: agent.repairToolCall(config?.abortSignal),
    onError: (error) => {
      console.error(
        chalk.red(
          `Error during agent (${agent.internalName})(${runId}) execution: `,
        ),
        error instanceof Error ? error.message : error,
      );
      console.dir(error, { depth: null });
    },
    output: agent.output ? Output.object({ schema: agent.output }) : undefined,
    onToolExecutionStart: ({ toolCall }) => {
      console.log(
        `Debug: (${runId}) ${chalk.bold.yellow('ToolCalled')}: ${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
      );
    },
    prepareStep: prepareStep(agent, agent.model, contextVariables),
    // onEnd: (result) => {
    //   (contextVariables as any).content = result.content;
    // },
  });
  return stream;
}

export const stream = execute;

export const prepareStep = <CIn>(
  agent: Agent<unknown, CIn, any>,
  model: AgentModel,
  contextVariables: CIn & SwarmContext,
): PrepareStepFunction<NoInfer<ToolSet>> => {
  return async ({ steps, messages }) => {
    const step = steps.at(-1);
    const agentName = contextVariables.currentActiveAgent;
    if (!step) {
      return await prepareAgent(model, agent, messages, contextVariables);
    }
    if (!agentName) {
      return await prepareAgent(model, agent, messages, contextVariables);
    }

    const nextAgent = findAgent(agent, agentName);
    if (!nextAgent) {
      console.error(`Debug: ${chalk.red('NotFound')}: Agent ${agentName}`);
      console.dir(
        {
          // Each step without its raw request and response.
          steps: steps.map((step) =>
            Object.fromEntries(
              Object.entries(step).filter(
                ([key]) => key !== 'request' && key !== 'response',
              ),
            ),
          ),
          messages,
        },
        { depth: null },
      );
      return void 0;
    }
    return await prepareAgent(model, nextAgent, messages, contextVariables);
  };
};

export function swarm<CIn>(
  agent: Agent<unknown, CIn, any>,
  messages: UIMessage[] | string,
  contextVariables: CIn & SwarmContext,
  abortSignal?: AbortSignal,
) {
  const originalMessages = Array.isArray(messages)
    ? messages
    : [messageToUiMessage(messages)];
  const tools = agent.toToolset();
  return createUIMessageStream({
    originalMessages,
    generateId: generateId,
    async execute({ writer }) {
      const stream = await execute(agent, originalMessages, contextVariables, {
        abortSignal,
      });
      const parts: UIMessagePart<UIDataTypes, UITools>[] = [];

      writer.merge(
        toUIMessageStream({
          stream: stream.stream,
          tools,
          sendFinish: false,
          sendStart: true,
          onEnd: (event) => {
            parts.push(...event.responseMessage.parts);
          },
        }),
      );
      await stream.consumeStream({ onError: console.error });
      await last(stream.stream);

      if (!agent.prepareEnd) return;

      while (true) {
        if (contextVariables.currentActiveAgent === undefined) {
          console.warn(
            `swarm: active agent was never set, so no prepareEnd call will be made`,
          );
          return;
        }
        if (contextVariables.currentActiveAgent === agent.internalName) {
          console.warn(
            `swarm: active agent is the root agent, so no prepareEnd call will be made`,
          );
          return;
        }
        const responseMessage = { id: '', parts, role: 'assistant' } as const;

        const streamOrPromise = agent.prepareEnd({
          responseMessage,
          messages: [...originalMessages, responseMessage],
          contextVariables,
          abortSignal,
        });
        const stream = await Promise.resolve(streamOrPromise);
        if (!stream) break;

        writer.merge(
          toUIMessageStream({
            stream: stream.stream,
            tools,
            sendFinish: false,
            sendStart: false,
            onEnd: (event) => {
              parts.push(...event.responseMessage.parts);
            },
          }),
        );
        await stream.consumeStream({ onError: console.error });
        await last(stream.stream);
      }

      writer.write({ type: 'finish' });
    },
  });
}

export async function prepareAgent<CIn>(
  defaultModel: AgentModel,
  agent: Agent<unknown, CIn, any>,
  messages: ModelMessage[],
  contextVariables?: CIn,
): Promise<PrepareStepResult<NoInfer<ToolSet>>> {
  agent.debug();
  await agent.prepareHandoff?.(messages);

  // In v6, structured output is handled natively by Output.object()
  // No need for middleware to add response_format
  const stepModel = agent.model ?? defaultModel;
  return {
    instructions: agent.instructions(contextVariables),
    activeTools: agent.toolsNames,
    model: stepModel,
    messages,
    toolChoice: agent.toolChoice,
  } as const;
}

function findAgent<CIn>(agent: Agent<unknown, CIn, any>, agentName: string) {
  // FIXME: first argument agent not always the first passed agent.
  return [...agent.toHandoffs(), agent].find(
    (it) => it.handoff.name === agentName,
  );
}
