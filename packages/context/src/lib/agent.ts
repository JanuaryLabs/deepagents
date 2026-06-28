import {
  type FlexibleSchema,
  type GenerateTextResult,
  type InferSchema,
  Output,
  type StreamTextResult,
  type StreamTextTransform,
  type Tool,
  type ToolChoice,
  type ToolSet,
  type UIMessage,
  type UIMessageStreamWriter,
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  generateText,
  smoothStream,
  stepCountIs,
  streamText,
  tool,
} from 'ai';
import chalk from 'chalk';
import z from 'zod';

import { type ContextEngine, XmlRenderer } from '../index.ts';
import {
  type AdvisorResult,
  type AgentModel,
  type AsAdvisorOptions,
  addUsage,
  advisorPreamble,
  executorContext,
  mapGenerateErrorToCode,
  nullUsage,
} from './advisor.ts';
import { assistant } from './fragments.ts';
import { toToolReminderModelOutput, user } from './fragments/message/user.ts';
import {
  type Guardrail,
  type GuardrailContext,
  runGuardrailChain,
} from './guardrail.ts';
import { createRepairToolCall } from './repair.ts';
import type { AgentSandbox } from './sandbox/types.ts';

export type OutputExtractorFn = (
  output: GenerateTextResult<ToolSet, any>,
) => string | Promise<string>;

export interface CreateAgent<CIn, COut = CIn> {
  name: string;
  sandbox: AgentSandbox;
  context?: ContextEngine;
  tools?: ToolSet;
  model?: AgentModel;
  toolChoice?: ToolChoice<Record<string, COut>>;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  experimental_telemetry?: Parameters<
    typeof generateText
  >[0]['experimental_telemetry'];
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
  readonly context?: ContextEngine;
  readonly model?: AgentModel;
  readonly sandbox: AgentSandbox;
  constructor(options: CreateAgent<CIn, COut>) {
    this.#options = options;
    this.tools = wrapToolsWithOutputReminders(
      { ...options.sandbox.tools, ...(options.tools || {}) },
      options.context,
    );
    this.context = options.context;
    this.model = options.model;
    this.sandbox = options.sandbox;
    this.#guardrails = options.guardrails || [];
  }

  public async generate<COut, CIn = COut>(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
    },
  ): Promise<
    GenerateTextResult<ToolSet, Output.Output<string, string, unknown>>
  > {
    if (!this.#options.context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }
    if (!this.#options.model) {
      throw new Error(`Agent ${this.#options.name} is missing a model.`);
    }
    // Signal is intentionally NOT forwarded to context.resolve(): aborting the model
    // call should not preempt the resolver chain mid-walk. Loaders that need
    // cancellation should subscribe to the signal via their own ctx (passed
    // explicitly to context.resolve when callers want resolver-level cancellation).
    const { messages, systemPrompt } = await this.#options.context.resolve({
      renderer: new XmlRenderer(),
      sandbox: this.#options.sandbox,
    });
    return generateText({
      abortSignal: config?.abortSignal,
      providerOptions: this.#options.providerOptions,
      experimental_telemetry: this.#options.experimental_telemetry,
      model: this.#options.model,
      system: systemPrompt,
      messages: await convertToModelMessages(messages as never, {
        ignoreIncompleteToolCalls: true,
        tools: this.tools,
      }),
      stopWhen: stepCountIs(200),
      tools: this.tools,
      experimental_context: contextVariables,
      experimental_repairToolCall: createRepairToolCall(
        this.#options.model,
        config?.abortSignal,
      ),
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
    const context = this.#options.context;
    if (!context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }

    const model = this.#options.model;
    if (!model) {
      throw new Error(`Agent ${this.#options.name} is missing a model.`);
    }

    const { messages, systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
      sandbox: this.#options.sandbox,
    });

    const runId = generateId();
    return streamText({
      abortSignal: config?.abortSignal,
      providerOptions: this.#options.providerOptions,
      experimental_telemetry: this.#options.experimental_telemetry,
      model,
      system: systemPrompt,
      messages: await convertToModelMessages(messages as never, {
        ignoreIncompleteToolCalls: true,
        tools: this.tools,
      }),
      experimental_repairToolCall: createRepairToolCall(
        model,
        config?.abortSignal,
      ),
      stopWhen: stepCountIs(200),
      prepareStep: context.createSteerPrepareStep(),
      experimental_transform: config?.transform ?? smoothStream(),
      tools: this.tools,
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
   * 1. The feedback is written to the output stream (user sees the correction)
   * 2. A finish-step is emitted, triggering onStepFinish to persist the self-correction
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
    const context = this.#options.context;
    if (!context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }

    // Save original method BEFORE override (prevents infinite recursion)
    const originalToUIMessageStream = result.toUIMessageStream.bind(result);

    // Override toUIMessageStream with guardrail logic
    result.toUIMessageStream = (options) => {
      const assistantMsgId = options?.generateMessageId?.();
      let stepSaved: PromiseWithResolvers<void> | null = null;

      return createUIMessageStream({
        generateId: assistantMsgId ? () => assistantMsgId : generateId,
        onStepFinish: async ({ responseMessage }) => {
          if (!stepSaved) return;

          // When chat() reserved an assistant head (the steer-capable path),
          // route through writeAssistantSegment so the steer split is honored and
          // we stay idempotent with chat()'s own onStepFinish. For direct
          // guardrail usage with no reserved placeholder, append a fresh assistant.
          const head = await context.headMessage();
          if (head?.name === 'assistant') {
            await context.writeAssistantSegment(responseMessage as UIMessage);
          } else {
            const message = assistantMsgId
              ? ({ ...responseMessage, id: assistantMsgId } as UIMessage)
              : (responseMessage as UIMessage);
            context.set(assistant(message));
            await context.save({ branch: false });
          }

          stepSaved.resolve();
          stepSaved = null;
        },
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
            if (config?.abortSignal?.aborted) {
              writer.write({ type: 'finish' });
              return;
            }

            attempt++;
            let guardrailFailed = false;
            let failureFeedback = '';

            const uiStream =
              currentResult === result
                ? originalToUIMessageStream(options)
                : currentResult.toUIMessageStream(options);

            for await (const part of uiStream) {
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

                break;
              }

              if (checkResult.type === 'stop') {
                console.log(
                  chalk.red(
                    `[${this.#options.name}] Guardrail stopped - unrecoverable error, no retry`,
                  ),
                );
                writer.write(part);
                writer.write({ type: 'finish' });
                return;
              }

              writer.write(part);
            }

            if (!guardrailFailed) {
              writer.write({ type: 'finish' });
              return;
            }

            if (attempt >= maxRetries) {
              console.error(
                chalk.red(
                  `[${this.#options.name}] Guardrail retry limit (${maxRetries}) exceeded.`,
                ),
              );
              writer.write({ type: 'finish' });
              return;
            }

            writeText(writer, failureFeedback);

            stepSaved = Promise.withResolvers<void>();
            writer.write({ type: 'finish-step' as const });
            await stepSaved.promise;

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

  public asTool(props?: {
    toolDescription?: string;
    outputExtractor?: OutputExtractorFn;
  }) {
    return tool({
      description:
        props?.toolDescription ||
        `Delegate to the ${this.#options.name} agent to handle the request.`,
      inputSchema: z.object({
        input: z.string(),
        output: z
          .string()
          .optional()
          .describe(
            'Optional instructions on how the final output should be formatted. this would be passed to the underlying llm as part of the prompt.',
          ),
      }),
      execute: async ({ input, output }, options) => {
        if (!this.context) {
          throw new Error(
            `Agent ${this.#options.name} is missing a context for asTool().`,
          );
        }
        if (!this.model) {
          throw new Error(
            `Agent ${this.#options.name} is missing a model for asTool().`,
          );
        }

        try {
          const ctx = this.context.fork();
          const prompt = output
            ? `${input}\n\n<OutputInstructions>\n${output}\n</OutputInstructions>`
            : input;
          ctx.set(user(prompt));

          const sub = agent({
            name: this.#options.name,
            sandbox: this.#options.sandbox,
            model: this.model,
            context: ctx,
            tools: this.#options.tools,
            providerOptions: this.#options.providerOptions,
            experimental_telemetry: this.#options.experimental_telemetry,
          });

          const result = await sub.generate(
            {},
            {
              abortSignal: options.abortSignal,
            },
          );

          if (props?.outputExtractor) {
            return await props.outputExtractor(result);
          }
          return result.steps.map((it) => it.toolResults).flat();
        } catch (error) {
          console.error(error);
          const details =
            error instanceof Error ? error.message : JSON.stringify(error);
          return `An error thrown from a tool call. \n<ErrorDetails>\n${details}\n</ErrorDetails>`;
        }
      },
    });
  }

  public asAdvisor(options?: AsAdvisorOptions): AdvisorResult {
    const maxUses = options?.maxUses;
    const maxConversationUses = options?.maxConversationUses;
    const maxOutputTokens = options?.maxOutputTokens ?? 1024;

    let callCount = 0;
    let successfulCalls = 0;
    let accumulatedUsage = nullUsage();

    const advisorTool = tool({
      description:
        'Consult a stronger advisor model for strategic guidance. Takes no parameters — your full conversation context is forwarded automatically. Call before substantive work, when stuck, when changing approach, or before declaring a task complete.',
      inputSchema: z.object({}),
      execute: async (_input, executionOptions) => {
        if (!this.context) {
          throw new Error(
            `Agent ${this.#options.name} is missing a context for asAdvisor().`,
          );
        }
        if (!this.model) {
          throw new Error(
            `Agent ${this.#options.name} is missing a model for asAdvisor().`,
          );
        }

        const slot = callCount++;
        if (maxUses !== undefined && slot >= maxUses) {
          return 'max_uses_exceeded';
        }
        if (
          maxConversationUses !== undefined &&
          successfulCalls >= maxConversationUses
        ) {
          return 'max_uses_exceeded';
        }

        const renderedExecutorPrompt = this.context.render(new XmlRenderer());
        const advisorCtx = this.context.fork();
        advisorCtx.set(
          advisorPreamble(),
          executorContext(renderedExecutorPrompt),
        );
        const advisorSystemPrompt = advisorCtx.render(new XmlRenderer());

        try {
          const result = await generateText({
            model: this.model,
            system: advisorSystemPrompt,
            messages: executionOptions.messages,
            maxOutputTokens,
            abortSignal: executionOptions.abortSignal,
            providerOptions: this.#options.providerOptions,
          });

          successfulCalls++;
          accumulatedUsage = addUsage(accumulatedUsage, result.usage);

          return result.text;
        } catch (error) {
          const code = mapGenerateErrorToCode(error);
          if (code) return code;
          throw error;
        }
      },
    });

    return {
      tool: advisorTool as Tool<Record<string, never>, string>,
      usage: () => ({
        calls: successfulCalls,
        totalUsage: { ...accumulatedUsage },
      }),
    };
  }

  clone(overrides?: Partial<CreateAgent<CIn, COut>>): Agent<CIn, COut> {
    return new Agent<CIn, COut>({
      ...this.#options,
      ...overrides,
    });
  }
}

/**
 * Wrap every executable tool so `target: 'tool-output'` reminders are applied
 * to the raw result at the execution boundary. The store keeps the host-marked
 * envelope; the model-facing projection strips the host-only marker while
 * preserving the result and reminder text.
 * Streaming results (async iterables) pass through untouched — wrapping them
 * would break their consumption contract.
 */
function wrapToolsWithOutputReminders(
  tools: ToolSet,
  context: ContextEngine | undefined,
): ToolSet {
  if (!context) return tools;

  const wrapped: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = toolDef.execute;
    if (typeof execute !== 'function') {
      wrapped[name] = toolDef;
      continue;
    }
    const originalToModelOutput = toolDef.toModelOutput;
    wrapped[name] = {
      ...toolDef,
      execute: async (input, options) => {
        const result = await execute.call(toolDef, input, options);
        if (isAsyncIterable(result)) return result;
        return context.applyToolOutputReminders(result);
      },
      toModelOutput: (args: {
        toolCallId: string;
        input: unknown;
        output: unknown;
      }) => {
        const project = (output: unknown) =>
          originalToModelOutput
            ? originalToModelOutput({
                ...args,
                output,
              } as Parameters<typeof originalToModelOutput>[0])
            : defaultToolModelOutput(output);
        return (
          toToolReminderModelOutput(args.output, project) ??
          project(args.output)
        );
      },
    } as typeof toolDef;
  }
  return wrapped;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}

// Mirrors the AI SDK's default tool-output projection for tools that have no
// `toModelOutput` of their own; the wrapper must supply one to hide envelope meta.
function defaultToolModelOutput(output: unknown) {
  return typeof output === 'string'
    ? { type: 'text' as const, value: output }
    : { type: 'json' as const, value: output ?? null };
}

export function agent<CIn, COut = CIn>(
  options: CreateAgent<CIn, COut>,
): Agent<CIn, COut> {
  return new Agent(options);
}

/**
 * Options for creating a structured output handler.
 */
export interface StructuredOutputOptions<TSchema extends FlexibleSchema> {
  context?: ContextEngine;
  model?: AgentModel;
  schema: TSchema;
  /**
   * Optional sandbox forwarded to context.resolve(). Required only when the
   * referenced context contains values that dispatch to resolvers declaring
   * `requiresSandbox` (e.g. async/sync/generator function loaders).
   */
  sandbox?: AgentSandbox;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  experimental_telemetry?: Parameters<
    typeof generateText
  >[0]['experimental_telemetry'];
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
export interface StructuredOutputResult<TSchema extends FlexibleSchema> {
  generate<CIn>(
    contextVariables?: CIn,
    config?: { abortSignal?: AbortSignal },
  ): Promise<InferSchema<TSchema>>;
  stream<CIn>(
    contextVariables?: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
    },
  ): Promise<
    StreamTextResult<ToolSet, Output.Output<unknown, unknown, unknown>>
  >;
}

export function structuredOutput<TSchema extends FlexibleSchema>(
  options: StructuredOutputOptions<TSchema>,
): StructuredOutputResult<TSchema> {
  return {
    async generate<CIn>(
      contextVariables?: CIn,
      config?: { abortSignal?: AbortSignal },
    ): Promise<InferSchema<TSchema>> {
      if (!options.context) {
        throw new Error(`structuredOutput is missing a context.`);
      }
      if (!options.model) {
        throw new Error(`structuredOutput is missing a model.`);
      }

      const { messages, systemPrompt } = await options.context.resolve({
        renderer: new XmlRenderer(),
        sandbox: options.sandbox,
      });

      const result = await generateText({
        abortSignal: config?.abortSignal,
        providerOptions: options.providerOptions,
        experimental_telemetry: options.experimental_telemetry,
        model: options.model,
        system: systemPrompt,
        messages: await convertToModelMessages(messages as never, {
          ignoreIncompleteToolCalls: true,
          tools: options.tools,
        }),
        stopWhen: stepCountIs(200),
        experimental_repairToolCall: createRepairToolCall(
          options.model,
          config?.abortSignal,
        ),
        experimental_context: contextVariables,
        output: Output.object({ schema: options.schema }),
        tools: options.tools,
      });

      return result.output as InferSchema<TSchema>;
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
        sandbox: options.sandbox,
      });

      return streamText({
        abortSignal: config?.abortSignal,
        providerOptions: options.providerOptions,
        experimental_telemetry: options.experimental_telemetry,
        model: options.model,
        system: systemPrompt,
        experimental_repairToolCall: createRepairToolCall(
          options.model,
          config?.abortSignal,
        ),
        messages: await convertToModelMessages(messages as never, {
          ignoreIncompleteToolCalls: true,
          tools: options.tools,
        }),
        stopWhen: stepCountIs(200),
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
