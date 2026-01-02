import {
  Output,
  type StreamTextTransform,
  type ToolChoice,
  type ToolSet,
  convertToModelMessages,
  generateId,
  generateText,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import chalk from 'chalk';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';

import { type ContextEngine, XmlRenderer } from '../index.ts';

export interface CreateAgent<COut, CIn = COut, Output = never> {
  name: string;
  context: ContextEngine;
  tools?: ToolSet;
  model: AgentModel;
  toolChoice?: ToolChoice<Record<string, COut>>;
  output?: z.Schema<Output>;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  logging?: boolean;
}

class Agent<COut, CIn = COut, Output = never> {
  #options: CreateAgent<COut, CIn, Output>;
  constructor(options: CreateAgent<COut, CIn, Output>) {
    this.#options = options;
  }

  public async generate<COut, CIn = COut, Output = never>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
    },
  ) {
    const { messages, systemPrompt } = await this.#options.context.resolve({
      renderer: new XmlRenderer(),
    });
    // console.log({ messages, systemPrompt });
    // if (messages.length) {
    //   process.exit(1);
    // }
    return generateText({
      abortSignal: config?.abortSignal,
      providerOptions: this.#options.providerOptions,
      model: this.#options.model,
      system: systemPrompt,
      messages: convertToModelMessages(messages as never),
      stopWhen: stepCountIs(25),
      tools: this.#options.tools,
      experimental_context: contextVariables,
      toolChoice: this.#options.toolChoice,
      experimental_output: this.#options.output
        ? Output.object({ schema: this.#options.output })
        : undefined,
      onStepFinish: (step) => {
        const toolCall = step.toolCalls.at(-1);
        if (toolCall) {
          console.log(
            `Debug: ${chalk.yellow('ToolCalled')}: ${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
          );
        }
      },
    });
  }

  public async stream<COut, CIn = COut, Output = never>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
    },
  ) {
    const { messages, systemPrompt } = await this.#options.context.resolve({
      renderer: new XmlRenderer(),
    });
    const runId = generateId();
    const stream = streamText({
      abortSignal: config?.abortSignal,
      providerOptions: this.#options.providerOptions,
      model: this.#options.model,
      system: systemPrompt,
      messages: convertToModelMessages(messages as never),
      stopWhen: stepCountIs(25),
      experimental_transform: config?.transform ?? smoothStream(),
      tools: this.#options.tools,
      experimental_context: contextVariables,
      toolChoice: this.#options.toolChoice,
      onError: (error) => {
        console.error(
          chalk.red(
            `Error during agent (${this.#options.name})(${runId}) execution: `,
          ),
          error instanceof Error ? error.message : error,
        );
        console.dir(error, { depth: null });
      },
      experimental_output: this.#options.output
        ? Output.object({ schema: this.#options.output })
        : undefined,
      onStepFinish: (step) => {
        const toolCall = step.toolCalls.at(-1);
        if (toolCall) {
          console.log(
            `Debug: (${runId}) ${chalk.bold.yellow('ToolCalled')}: ${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
          );
        }
      },
    });
    return stream;
    // const textContent: Record<
    //   string,
    //   {
    //     type: string;
    //     text: string;
    //     providerMetadata?: Record<string, unknown>;
    //   }
    // > = {};
    // for await (const part of stream.fullStream) {
    //   // console.log(event.type === 'text');
    //   if (part.type === 'text-start') {
    //     textContent[part.id] ??= {
    //       type: 'text',
    //       text: '',
    //       providerMetadata: part.providerMetadata,
    //     };
    //   }
    //   if (part.type === 'text-delta') {
    //     if (!textContent[part.id]) {
    //       throw new Error('Text part delta received without start');
    //     }
    //     textContent[part.id].text += part.text;
    //   }
    //   if (part.type === 'text-end') {
    //     if (!textContent[part.id]) {
    //       throw new Error('Text part end received without start');
    //     }
    //     textContent[part.id].providerMetadata ??= part.providerMetadata;
    //   }
    // }
  }
}

export function agent<Output, CIn, COut = CIn>(
  options: CreateAgent<COut, CIn, Output>,
): Agent<COut, CIn, Output> {
  return new Agent(options);
}
