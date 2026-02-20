import {
  type GenerateTextResult,
  Output,
  type StreamTextResult,
  type StreamTextTransform,
  type ToolChoice,
  type ToolSet,
  type UIMessageStreamWriter,
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  generateText,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import chalk from 'chalk';
import z from 'zod';

import { type AgentModel, createRepairToolCall } from '@deepagents/agent';

import { type ContextEngine, XmlRenderer } from '../index.ts';
import { lastAssistantMessage } from './fragments.ts';
import {
  type Guardrail,
  type GuardrailContext,
  runGuardrailChain,
} from './guardrail.ts';

export interface CreateAgent<CIn, COut = CIn> {
  name: string;
  context?: ContextEngine;
  tools?: ToolSet;
  model?: AgentModel;
  toolChoice?: ToolChoice<Record<string, COut>>;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  logging?: boolean;
  /**
   * Guardrails to apply during streaming.
   * Each guardrail inspects text chunks and can trigger self-correction retries.
   */
  guardrails?: Guardrail[];
  /**
   * Maximum number of retry attempts when guardrails fail (default: 3).
   */
  maxGuardrailRetries?: number;
}

class Agent<CIn, COut = CIn> {
  #options: CreateAgent<CIn, COut>;
  #guardrails: Guardrail[] = [];
  readonly tools: ToolSet;
  constructor(options: CreateAgent<CIn, COut>) {
    this.#options = options;
    this.tools = options.tools || {};
    this.#guardrails = options.guardrails || [];
  }

  public async generate<COut, CIn = COut>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
    },
  ): Promise<GenerateTextResult<ToolSet, Output.Output<string, string, any>>> {
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
      messages: await convertToModelMessages(messages as never),
      stopWhen: stepCountIs(25),
      tools: this.#options.tools,
      experimental_context: contextVariables,
      experimental_repairToolCall: createRepairToolCall(this.#options.model),
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

  /**
   * Stream a response from the agent.
   *
   * When guardrails are configured, `toUIMessageStream()` is wrapped to provide
   * self-correction behavior. Direct access to fullStream/textStream bypasses guardrails.
   *
   * @example
   * ```typescript
   * const stream = await agent.stream({});
   *
   * // With guardrails - use toUIMessageStream for protection
   * await printer.readableStream(stream.toUIMessageStream());
   *
   * // Or use printer.stdout which uses toUIMessageStream internally
   * await printer.stdout(stream);
   * ```
   */
  public async stream<COut, CIn = COut>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
      maxRetries?: number;
    },
  ): Promise<StreamTextResult<ToolSet, never>> {
    if (!this.#options.context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }
    if (!this.#options.model) {
      throw new Error(`Agent ${this.#options.name} is missing a model.`);
    }

    const result = await this.#createRawStream(contextVariables, config);

    if (this.#guardrails.length === 0) {
      return result;
    }

    return this.#wrapWithGuardrails(result, contextVariables, config);
  }

  /**
   * Create a raw stream without guardrail processing.
   */
  async #createRawStream<COut, CIn = COut>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
    },
  ) {
    const { messages, systemPrompt } = await this.#options.context!.resolve({
      renderer: new XmlRenderer(),
    });

    const runId = generateId();
    return streamText({
      abortSignal: config?.abortSignal,
      providerOptions: this.#options.providerOptions,
      model: this.#options.model!,
      system: systemPrompt,
      messages: await convertToModelMessages(messages as never),
      experimental_repairToolCall: createRepairToolCall(this.#options.model!),
      stopWhen: stepCountIs(50),
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
  }

  /**
   * Wrap a StreamTextResult with guardrail protection on toUIMessageStream().
   *
   * When a guardrail fails:
   * 1. Accumulated text + feedback is appended as the assistant's self-correction
   * 2. The feedback is written to the output stream (user sees the correction)
   * 3. A new stream is started and the model continues from the correction
   */
  #wrapWithGuardrails<CIn>(
    result: StreamTextResult<ToolSet, never>,
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
      maxRetries?: number;
    },
  ): StreamTextResult<ToolSet, never> {
    const maxRetries =
      config?.maxRetries ?? this.#options.maxGuardrailRetries ?? 3;
    const context = this.#options.context!;

    // Save original method BEFORE override (prevents infinite recursion)
    const originalToUIMessageStream = result.toUIMessageStream.bind(result);

    // Override toUIMessageStream with guardrail logic
    result.toUIMessageStream = (options) => {
      return createUIMessageStream({
        generateId,
        execute: async ({ writer }) => {
          let currentResult: StreamTextResult<ToolSet, never> = result;
          let attempt = 0;

          // Create guardrail context with available tools and skills
          const { mounts } = context.getSkillMounts();
          const guardrailContext: GuardrailContext = {
            availableTools: Object.keys(this.tools),
            availableSkills: mounts,
          };

          while (attempt < maxRetries) {
            // Check if request was cancelled before starting new attempt
            if (config?.abortSignal?.aborted) {
              writer.write({ type: 'finish' });
              return;
            }

            attempt++;
            let accumulatedText = '';
            let guardrailFailed = false;
            let failureFeedback = '';

            // Use original method for first result (avoids recursion), new results have their own original
            const uiStream =
              currentResult === result
                ? originalToUIMessageStream(options)
                : currentResult.toUIMessageStream(options);

            for await (const part of uiStream) {
              // Run through guardrail chain - guardrails can handle any part type
              const checkResult = runGuardrailChain(
                part,
                this.#guardrails,
                guardrailContext,
              );

              if (checkResult.type === 'fail') {
                guardrailFailed = true;
                failureFeedback = checkResult.feedback;

                console.log(
                  chalk.yellow(
                    `[${this.#options.name}] Guardrail triggered (attempt ${attempt}/${maxRetries}): ${failureFeedback.slice(0, 50)}...`,
                  ),
                );

                break; // Exit stream processing
              }

              if (checkResult.type === 'stop') {
                // Stop immediately without retry - write part and finish
                console.log(
                  chalk.red(
                    `[${this.#options.name}] Guardrail stopped - unrecoverable error, no retry`,
                  ),
                );
                writer.write(part);
                writer.write({ type: 'finish' });
                return;
              }

              // Guardrail passed - track text for self-correction context
              if (checkResult.part.type === 'text-delta') {
                accumulatedText += checkResult.part.delta;
              }

              // Write the (possibly modified) part to output
              writer.write(part);
            }

            if (!guardrailFailed) {
              // Stream completed successfully
              writer.write({ type: 'finish' });
              return;
            }

            // Check if we've exceeded max retries BEFORE writing feedback
            if (attempt >= maxRetries) {
              console.error(
                chalk.red(
                  `[${this.#options.name}] Guardrail retry limit (${maxRetries}) exceeded.`,
                ),
              );
              writer.write({ type: 'finish' });
              return;
            }

            // Guardrail failed but we have retries left - prepare for retry
            // Write the self-correction feedback to the output stream
            writeText(writer, failureFeedback);

            // Add the partial assistant message + feedback to context
            // Uses lastAssistantMessage which finds/reuses the last assistant ID
            const selfCorrectionText = accumulatedText + ' ' + failureFeedback;
            context.set(lastAssistantMessage(selfCorrectionText));

            // Save to persist the self-correction (prevents duplicate messages on next resolve)
            await context.save({ branch: false });

            // Create new stream for retry
            currentResult = await this.#createRawStream(
              contextVariables,
              config,
            );
          }
        },
        onError: (error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          return `Stream failed: ${message}`;
        },
      });
    };

    return result;
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
  context?: ContextEngine;
  model?: AgentModel;
  schema: TSchema;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  tools?: ToolSet;
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
export interface StructuredOutputResult<TSchema extends z.ZodType> {
  generate<CIn>(
    contextVariables?: CIn,
    config?: { abortSignal?: AbortSignal },
  ): Promise<z.infer<TSchema>>;
  stream<CIn>(
    contextVariables?: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
    },
  ): Promise<StreamTextResult<ToolSet, any>>;
}

export function structuredOutput<TSchema extends z.ZodType>(
  options: StructuredOutputOptions<TSchema>,
): StructuredOutputResult<TSchema> {
  return {
    async generate<CIn>(
      contextVariables?: CIn,
      config?: { abortSignal?: AbortSignal },
    ): Promise<z.infer<TSchema>> {
      if (!options.context) {
        throw new Error(`structuredOutput is missing a context.`);
      }
      if (!options.model) {
        throw new Error(`structuredOutput is missing a model.`);
      }

      const { messages, systemPrompt } = await options.context.resolve({
        renderer: new XmlRenderer(),
      });

      const result = await generateText({
        abortSignal: config?.abortSignal,
        providerOptions: options.providerOptions,
        model: options.model,
        system: systemPrompt,
        messages: await convertToModelMessages(messages as never),
        stopWhen: stepCountIs(25),
        experimental_repairToolCall: createRepairToolCall(options.model),
        experimental_context: contextVariables,
        output: Output.object({ schema: options.schema }),
        tools: options.tools,
      });

      return result.output as z.infer<TSchema>;
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
        throw new Error(`structuredOutput is missing a context.`);
      }
      if (!options.model) {
        throw new Error(`structuredOutput is missing a model.`);
      }

      const { messages, systemPrompt } = await options.context.resolve({
        renderer: new XmlRenderer(),
      });

      return streamText({
        abortSignal: config?.abortSignal,
        providerOptions: options.providerOptions,
        model: options.model,
        system: systemPrompt,
        experimental_repairToolCall: createRepairToolCall(options.model),
        messages: await convertToModelMessages(messages as never),
        stopWhen: stepCountIs(50),
        experimental_transform: config?.transform ?? smoothStream(),
        experimental_context: contextVariables,
        output: Output.object({ schema: options.schema }),
        tools: options.tools,
      });
    },
  };
}

function writeText(writer: UIMessageStreamWriter, text: string) {
  const feedbackPartId = generateId();
  writer.write({
    id: feedbackPartId,
    type: 'text-start',
  });
  writer.write({
    id: feedbackPartId,
    type: 'text-delta',
    delta: ` ${text}`,
  });
  writer.write({
    id: feedbackPartId,
    type: 'text-end',
  });
}
