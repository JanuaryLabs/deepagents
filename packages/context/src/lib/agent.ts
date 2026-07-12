import type { JSONObject } from '@ai-sdk/provider';
import {
  type FlexibleSchema,
  type GenerateTextResult,
  type InferSchema,
  Output,
  type PrepareStepFunction,
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
  isStepCount,
  smoothStream,
  streamText,
  tool,
} from 'ai';
import chalk from 'chalk';
import z from 'zod';

import { withHostOnlyToolMetadata } from '@deepagents/agent';

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
import { user } from './fragments/message/user.ts';
import {
  type Guardrail,
  type GuardrailContext,
  runGuardrailChain,
} from './guardrail.ts';
import { createRepairToolCall } from './repair.ts';
import type { AgentSandbox } from './sandbox/types.ts';

/** Input schema shape accepted by the tool `asTool()` produces. */
export interface SubagentToolInput {
  input: string;
  output?: string;
}

type SubagentExecuteOptions = Parameters<
  NonNullable<Tool<SubagentToolInput, string>['execute']>
>[1];

export type OutputExtractorFn<T = string> = (
  output: GenerateTextResult<ToolSet, any, any>,
) => T | Promise<T>;

export interface CreateAgent<CIn, COut = CIn> {
  name: string;
  sandbox: AgentSandbox;
  context?: ContextEngine;
  tools?: ToolSet;
  model?: AgentModel;
  toolChoice?: ToolChoice<Record<string, COut>>;
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
  telemetry?: Parameters<typeof generateText>[0]['telemetry'];
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
    this.tools = withHostOnlyToolMetadata({
      ...options.sandbox.tools,
      ...(options.tools || {}),
    });
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
    GenerateTextResult<ToolSet, any, Output.Output<string, string, unknown>>
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
      telemetry: this.#options.telemetry,
      model: this.#options.model,
      instructions: systemPrompt,
      messages: await convertToModelMessages(messages as never, {
        ignoreIncompleteToolCalls: true,
        tools: this.tools,
      }),
      stopWhen: isStepCount(200),
      prepareStep: this.#options.context.createPrepareStep({ steer: false }),
      tools: this.tools,
      runtimeContext: contextVariables as any,
      toolsContext: createToolsContext(this.tools, contextVariables) as any,
      repairToolCall: createRepairToolCall(
        this.#options.model,
        config?.abortSignal,
      ),
      toolChoice: this.#options.toolChoice,
      onStepEnd: (step) => {
        if (!this.#options.logging) return;
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
  ): Promise<StreamTextResult<ToolSet, any, any>> {
    if (!this.#options.context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }
    if (!this.#options.model) {
      throw new Error(`Agent ${this.#options.name} is missing a model.`);
    }

    const prepareStep = this.#options.context.createPrepareStep();
    const result = await this.#createRawStream(
      contextVariables,
      config,
      prepareStep,
    );

    if (this.#guardrails.length === 0) {
      return result;
    }

    return this.#wrapWithGuardrails(
      result,
      contextVariables,
      config,
      prepareStep,
    );
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
    prepareStep?: PrepareStepFunction<ToolSet>,
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
      telemetry: this.#options.telemetry,
      model,
      instructions: systemPrompt,
      messages: await convertToModelMessages(messages as never, {
        ignoreIncompleteToolCalls: true,
        tools: this.tools,
      }),
      repairToolCall: createRepairToolCall(model, config?.abortSignal),
      stopWhen: isStepCount(200),
      prepareStep: prepareStep ?? context.createPrepareStep(),
      experimental_transform: config?.transform ?? smoothStream(),
      tools: this.tools,
      runtimeContext: contextVariables as any,
      toolsContext: createToolsContext(this.tools, contextVariables) as any,
      toolChoice: this.#options.toolChoice,
      onStepEnd: (step) => {
        if (!this.#options.logging) return;
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
   * 2. A finish-step is emitted, triggering onStepEnd to persist the self-correction
   * 3. A new stream is started and the model continues from the correction
   */
  #wrapWithGuardrails<CIn>(
    result: StreamTextResult<ToolSet, any, any>,
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
      maxRetries?: number;
    },
    prepareStep?: PrepareStepFunction<ToolSet>,
  ): StreamTextResult<ToolSet, any, any> {
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
        onStepEnd: async ({ responseMessage }) => {
          if (!stepSaved) return;

          // When chat() reserved an assistant head (the steer-capable path),
          // route through writeAssistantSegment so reminder splits are honored and
          // we stay idempotent with chat()'s own onStepEnd. For direct
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
          let currentResult: StreamTextResult<ToolSet, any, any> = result;
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
              prepareStep,
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

  public asTool<T = string>(props?: {
    toolDescription?: string;
    outputExtractor?: OutputExtractorFn<T>;
    /** Not sent to the model; surfaces on tool call/result and UI message parts */
    metadata?: JSONObject;
    toModelOutput?: Tool<SubagentToolInput, T | string>['toModelOutput'];
  }) {
    // Tool gates `execute` behind NeverOptional<OUTPUT, …>, which cannot resolve
    // while OUTPUT is still a type parameter. Same bridge asAdvisor uses below.
    const definition = {
      description:
        props?.toolDescription ||
        `Delegate to the ${this.#options.name} agent to handle the request.`,
      metadata: props?.metadata,
      toModelOutput: props?.toModelOutput,
      inputSchema: z.object({
        input: z.string(),
        output: z
          .string()
          .optional()
          .describe(
            'Optional instructions on how the final output should be formatted. this would be passed to the underlying llm as part of the prompt.',
          ),
      }),
      execute: async (
        { input, output }: SubagentToolInput,
        options: SubagentExecuteOptions,
      ): Promise<T | string> => {
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
            telemetry: this.#options.telemetry,
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
          return result.text;
        } catch (error) {
          // Cancellation is control flow, not a tool failure: surfacing it as a
          // tool result would let the parent model keep reasoning past an abort.
          if (error instanceof Error && error.name === 'AbortError') {
            throw error;
          }
          console.error(error);
          const details =
            error instanceof Error ? error.message : JSON.stringify(error);
          return `An error thrown from a tool call. \n<ErrorDetails>\n${details}\n</ErrorDetails>`;
        }
      },
    } as unknown as Tool<SubagentToolInput, T | string>;

    return tool(definition);
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
            instructions: advisorSystemPrompt,
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
  telemetry?: Parameters<typeof generateText>[0]['telemetry'];
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
    StreamTextResult<ToolSet, any, Output.Output<unknown, unknown, unknown>>
  >;
}

export function structuredOutput<TSchema extends FlexibleSchema>(
  options: StructuredOutputOptions<TSchema>,
): StructuredOutputResult<TSchema> {
  const tools = options.tools
    ? withHostOnlyToolMetadata(options.tools)
    : undefined;
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
        telemetry: options.telemetry,
        model: options.model,
        instructions: systemPrompt,
        messages: await convertToModelMessages(messages as never, {
          ignoreIncompleteToolCalls: true,
          tools,
        }),
        stopWhen: isStepCount(200),
        repairToolCall: createRepairToolCall(
          options.model,
          config?.abortSignal,
        ),
        runtimeContext: contextVariables as any,
        toolsContext: createToolsContext(tools ?? {}, contextVariables) as any,
        output: Output.object({ schema: options.schema }),
        tools,
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
        telemetry: options.telemetry,
        model: options.model,
        instructions: systemPrompt,
        repairToolCall: createRepairToolCall(
          options.model,
          config?.abortSignal,
        ),
        messages: await convertToModelMessages(messages as never, {
          ignoreIncompleteToolCalls: true,
          tools,
        }),
        stopWhen: isStepCount(200),
        experimental_transform: config?.transform ?? smoothStream(),
        runtimeContext: contextVariables as any,
        toolsContext: createToolsContext(tools ?? {}, contextVariables) as any,
        output: Output.object({ schema: options.schema }),
        tools,
      });
    },
  };
}

function createToolsContext<C>(tools: ToolSet, context: C) {
  return Object.fromEntries(
    Object.keys(tools).map((toolName) => [toolName, context]),
  );
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
