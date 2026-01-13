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

export interface CreateAgent<CIn, COut = CIn> {
  name: string;
  context?: ContextEngine;
  tools?: ToolSet;
  model?: AgentModel;
  toolChoice?: ToolChoice<Record<string, COut>>;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  logging?: boolean;
}

class Agent<CIn, COut = CIn> {
  #options: CreateAgent<CIn, COut>;
  readonly tools: ToolSet;
  constructor(options: CreateAgent<CIn, COut>) {
    this.#options = options;
    this.tools = options.tools || {};
  }

  public async generate<COut, CIn = COut>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
    },
  ) {
    if (!this.#options.context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }
    if (!this.#options.model) {
      throw new Error(`Agent ${this.#options.name} is missing a model.`);
    }
    const { messages, systemPrompt } = await this.#options.context.resolve({
      renderer: new XmlRenderer(),
    });
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

  public async stream<COut, CIn = COut>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
    },
  ) {
    if (!this.#options.context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }
    if (!this.#options.model) {
      throw new Error(`Agent ${this.#options.name} is missing a model.`);
    }
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
  }

  clone(overrides?: Partial<CreateAgent<CIn, COut>>): Agent<CIn, COut> {
    return new Agent<CIn, COut>({
      ...this.#options,
      ...overrides,
    });
  }
}

export function agent<CIn, COut = CIn>(
  options: CreateAgent<CIn, COut>,
): Agent<CIn, COut> {
  return new Agent(options);
}

/**
 * Options for creating a structured output handler.
 */
export interface StructuredOutputOptions<TSchema extends z.ZodType> {
  name: string;
  context?: ContextEngine;
  model?: AgentModel;
  schema: TSchema;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
}

/**
 * Create a structured output handler that provides simplified access to structured output.
 *
 * @param options - Configuration options including schema
 * @returns Object with generate() and stream() methods
 *
 * @example
 * ```typescript
 * const output = structuredOutput({
 *   name: 'extractor',
 *   model: groq('...'),
 *   context,
 *   schema: z.object({
 *     name: z.string(),
 *     age: z.number(),
 *   }),
 * });
 *
 * // Generate - returns only the structured output
 * const result = await output.generate({});
 * // result: { name: string, age: number }
 *
 * // Stream - returns the full stream
 * const stream = await output.stream({});
 * ```
 */
export function structuredOutput<TSchema extends z.ZodType>(
  options: StructuredOutputOptions<TSchema>,
) {
  return {
    async generate<CIn>(
      contextVariables?: CIn,
      config?: { abortSignal?: AbortSignal },
    ): Promise<z.infer<TSchema>> {
      if (!options.context) {
        throw new Error(
          `structuredOutput "${options.name}" is missing a context.`,
        );
      }
      if (!options.model) {
        throw new Error(
          `structuredOutput "${options.name}" is missing a model.`,
        );
      }

      const { messages, systemPrompt } = await options.context.resolve({
        renderer: new XmlRenderer(),
      });

      const result = await generateText({
        abortSignal: config?.abortSignal,
        providerOptions: options.providerOptions,
        model: options.model,
        system: systemPrompt,
        messages: convertToModelMessages(messages as never),
        stopWhen: stepCountIs(25),
        experimental_context: contextVariables,
        experimental_output: Output.object({ schema: options.schema }),
      });

      return result.experimental_output as z.infer<TSchema>;
    },

    async stream<CIn>(
      contextVariables?: CIn,
      config?: {
        abortSignal?: AbortSignal;
        transform?:
          | StreamTextTransform<ToolSet>
          | StreamTextTransform<ToolSet>[];
      },
    ) {
      if (!options.context) {
        throw new Error(
          `structuredOutput "${options.name}" is missing a context.`,
        );
      }
      if (!options.model) {
        throw new Error(
          `structuredOutput "${options.name}" is missing a model.`,
        );
      }

      const { messages, systemPrompt } = await options.context.resolve({
        renderer: new XmlRenderer(),
      });

      return streamText({
        abortSignal: config?.abortSignal,
        providerOptions: options.providerOptions,
        model: options.model,
        system: systemPrompt,
        messages: convertToModelMessages(messages as never),
        stopWhen: stepCountIs(25),
        experimental_transform: config?.transform ?? smoothStream(),
        experimental_context: contextVariables,
        experimental_output: Output.object({ schema: options.schema }),
      });
    },
  };
}
