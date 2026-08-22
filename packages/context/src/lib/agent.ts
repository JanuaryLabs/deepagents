import type { JSONObject } from '@ai-sdk/provider';
import type {
  HasRequiredKey,
  InferToolSetContext,
  ToolExecutionOptions,
} from '@ai-sdk/provider-utils';
import {
  type FlexibleSchema,
  type GenerateTextResult,
  type InferSchema,
  Output,
  type PrepareStepFunction,
  type StreamTextResult,
  type StreamTextTransform,
  type Tool,
  type ToolLoopAgentSettings,
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

import {
  type ContextEngine,
  type PrepareStepInputProvider,
  XmlRenderer,
} from '../index.ts';
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

type PreparedTools<TOOLS extends ToolSet> = ReturnType<
  typeof withHostOnlyToolMetadata<TOOLS>
>;

type AgentModelTools<TOOLS extends ToolSet> = PreparedTools<
  AgentSandbox['tools'] & TOOLS
>;

type ToolCallOptions<TOOLS extends ToolSet, OPTIONS> = Pick<
  ToolLoopAgentSettings<never, TOOLS>,
  'toolsContext'
> &
  OPTIONS;

export type ToolCallArguments<TOOLS extends ToolSet, OPTIONS> =
  HasRequiredKey<InferToolSetContext<TOOLS>> extends true
    ? [options: ToolCallOptions<TOOLS, OPTIONS>]
    : [options?: ToolCallOptions<TOOLS, OPTIONS>];

type GenerateOptions = {
  abortSignal?: AbortSignal;
};

export type StreamOptions = {
  abortSignal?: AbortSignal;
  transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
  maxRetries?: number;
};

export interface CreateAgent<TOOLS extends ToolSet = {}> {
  name: string;
  sandbox: AgentSandbox;
  context?: ContextEngine;
  tools?: TOOLS;
  model?: AgentModel;
  toolChoice?: Parameters<
    typeof generateText<AgentModelTools<TOOLS>>
  >[0]['toolChoice'];
  providerOptions?: Parameters<
    typeof generateText<AgentModelTools<TOOLS>>
  >[0]['providerOptions'];
  telemetry?: Parameters<
    typeof generateText<AgentModelTools<TOOLS>>
  >[0]['telemetry'];
  runtimeContext?: Parameters<
    typeof generateText<AgentModelTools<TOOLS>>
  >[0]['runtimeContext'];
  experimental_toolCallers?: Parameters<
    typeof generateText<AgentModelTools<TOOLS>>
  >[0]['experimental_toolCallers'];
  /**
   * Ends the agent loop. Defaults to {@link DEFAULT_STOP_WHEN}. Raise it for a
   * long agentic run that would otherwise stop mid-task; lower it to bound cost
   * on an untrusted prompt.
   */
  stopWhen?: Parameters<typeof streamText>[0]['stopWhen'];
  /**
   * Guardrails to apply during streaming.
   * Each guardrail inspects text chunks and can trigger self-correction retries.
   */
  guardrails?: Guardrail[];
  /**
   * Maximum number of retry attempts when guardrails fail (default: 3).
   */
  maxGuardrailRetries?: number;
  /** Supplies durable user input before sampling and at safe step boundaries. */
  prepareStepInput?: PrepareStepInputProvider;
}

/**
 * Default ceiling for the agent loop. Kept in one place so the entry points
 * cannot drift; callers override it with `stopWhen` on `agent()`.
 */
export const DEFAULT_STOP_WHEN = isStepCount(200);

class Agent<TOOLS extends ToolSet> {
  #options: CreateAgent<TOOLS>;
  #guardrails: Guardrail[] = [];
  readonly tools: AgentModelTools<TOOLS>;
  readonly context?: ContextEngine;
  readonly model?: AgentModel;
  readonly sandbox: AgentSandbox;
  constructor(options: CreateAgent<TOOLS>) {
    this.#options = options;
    this.tools = withHostOnlyToolMetadata(
      Object.assign({}, options.sandbox.tools, options.tools),
    );
    this.context = options.context;
    this.model = options.model;
    this.sandbox = options.sandbox;
    this.#guardrails = options.guardrails || [];
  }

  public async generate(
    ...[options]: ToolCallArguments<AgentModelTools<TOOLS>, GenerateOptions>
  ): Promise<
    GenerateTextResult<
      AgentModelTools<TOOLS>,
      any,
      Output.Output<string, string, unknown>
    >
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
      abortSignal: options?.abortSignal,
      providerOptions: this.#options.providerOptions,
      telemetry: this.#options.telemetry,
      runtimeContext: this.#options.runtimeContext,
      model: this.#options.model,
      instructions: systemPrompt,
      messages: await convertToModelMessages(messages as never, {
        ignoreIncompleteToolCalls: true,
        tools: this.tools,
      }),
      stopWhen: this.#options.stopWhen ?? DEFAULT_STOP_WHEN,
      prepareStep: this.#options.context.createPrepareStep({
        steer: false,
        sandbox: this.#options.sandbox,
      }),
      tools: this.tools,
      toolsContext: options?.toolsContext,
      experimental_toolCallers: this.#options.experimental_toolCallers,
      repairToolCall: createRepairToolCall(
        this.#options.model,
        options?.abortSignal,
      ),
      toolChoice: this.#options.toolChoice,
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
   * const stream = await agent.stream();
   *
   * // With guardrails - use toUIMessageStream for protection
   * await printer.readableStream(stream.toUIMessageStream());
   *
   * // Or use printer.stdout which uses toUIMessageStream internally
   * await printer.stdout(stream);
   * ```
   */
  public async stream(
    ...[options]: ToolCallArguments<AgentModelTools<TOOLS>, StreamOptions>
  ): Promise<StreamTextResult<ToolSet, any, any>> {
    if (!this.#options.context) {
      throw new Error(`Agent ${this.#options.name} is missing a context.`);
    }
    if (!this.#options.model) {
      throw new Error(`Agent ${this.#options.name} is missing a model.`);
    }

    const prepareStep = this.#options.context.createPrepareStep({
      additionalInput: this.#options.prepareStepInput,
      sandbox: this.#options.sandbox,
    });
    const result = await this.#createRawStream(
      options?.toolsContext as InferToolSetContext<AgentModelTools<TOOLS>>,
      options,
      prepareStep,
    );

    if (this.#guardrails.length === 0) {
      return result;
    }

    return this.#wrapWithGuardrails(
      result,
      options?.toolsContext as InferToolSetContext<AgentModelTools<TOOLS>>,
      options,
      prepareStep,
    );
  }

  /**
   * Create a raw stream without guardrail processing.
   */
  async #createRawStream(
    toolsContext: InferToolSetContext<AgentModelTools<TOOLS>>,
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

    return streamText({
      abortSignal: config?.abortSignal,
      providerOptions: this.#options.providerOptions,
      telemetry: this.#options.telemetry,
      runtimeContext: this.#options.runtimeContext,
      model,
      instructions: systemPrompt,
      messages: await convertToModelMessages(messages as never, {
        ignoreIncompleteToolCalls: true,
        tools: this.tools,
      }),
      repairToolCall: createRepairToolCall(model, config?.abortSignal),
      stopWhen: this.#options.stopWhen ?? DEFAULT_STOP_WHEN,
      prepareStep:
        prepareStep ??
        context.createPrepareStep({ sandbox: this.#options.sandbox }),
      experimental_transform: config?.transform ?? smoothStream(),
      tools: this.tools,
      // Generic wrappers cannot reduce AI SDK's conditional context or caller maps.
      toolsContext: toolsContext as never,
      experimental_toolCallers: this.#options.experimental_toolCallers as never,
      toolChoice: this.#options.toolChoice,
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
  #wrapWithGuardrails(
    result: StreamTextResult<ToolSet, any, any>,
    toolsContext: InferToolSetContext<AgentModelTools<TOOLS>>,
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
          const guardrailContext: GuardrailContext = {
            availableTools: Object.keys(this.tools),
            availableSkills: context.getAvailableSkills(),
          };

          while (attempt < maxRetries) {
            if (config?.abortSignal?.aborted) {
              writer.write({ type: 'finish' });
              return;
            }

            attempt++;
            let guardrailFailed = false;
            let failureFeedback = '';
            // A guardrail typically rejects a text-delta, by which point the
            // enclosing text-start has already been forwarded. Track the open
            // part so the rejection can close it instead of orphaning it in a
            // permanent `state: 'streaming'`.
            let openTextId: string | undefined;

            const uiStream =
              currentResult === result
                ? originalToUIMessageStream(options)
                : currentResult.toUIMessageStream(options);

            for await (const part of uiStream) {
              if (part.type === 'text-start') openTextId = chunkId(part);
              if (part.type === 'text-end') openTextId = undefined;

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

            writeText(writer, failureFeedback, openTextId);

            stepSaved = Promise.withResolvers<void>();
            writer.write({ type: 'finish-step' as const });
            await stepSaved.promise;

            currentResult = await this.#createRawStream(
              toolsContext,
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
    outputExtractor?: (
      output: Awaited<ReturnType<Agent<TOOLS>['generate']>>,
    ) => T | Promise<T>;
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
        options: ToolExecutionOptions<
          InferToolSetContext<AgentModelTools<TOOLS>>
        >,
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

          const result = await this.clone({ context: ctx }).generate({
            toolsContext: options.context,
            abortSignal: options.abortSignal,
          });

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
    } as unknown as Tool<
      SubagentToolInput,
      T | string,
      InferToolSetContext<AgentModelTools<TOOLS>>
    >;

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

  clone(overrides?: Partial<CreateAgent<TOOLS>>): Agent<TOOLS> {
    return new Agent<TOOLS>({
      ...this.#options,
      ...overrides,
    });
  }
}

export function agent<const TOOLS extends ToolSet = {}>(
  options: CreateAgent<TOOLS>,
): Agent<TOOLS> {
  return new Agent(options);
}

/**
 * Options for creating a structured output handler.
 */
export interface StructuredOutputOptions<
  TSchema extends FlexibleSchema,
  TOOLS extends ToolSet = {},
> {
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
  tools?: TOOLS;
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
 *   model: groq('...'),
 *   context,
 *   schema: z.object({
 *     name: z.string(),
 *     age: z.number(),
 *   }),
 * });
 *
 * // Generate - returns only the structured output
 * const result = await output.generate();
 * // result: { name: string, age: number }
 *
 * // Stream - returns the full stream
 * const stream = await output.stream();
 * ```
 */
export interface StructuredOutputResult<
  TSchema extends FlexibleSchema,
  TOOLS extends ToolSet,
> {
  generate(
    ...args: ToolCallArguments<PreparedTools<TOOLS>, GenerateOptions>
  ): Promise<InferSchema<TSchema>>;
  stream(
    ...args: ToolCallArguments<PreparedTools<TOOLS>, StreamOptions>
  ): Promise<
    StreamTextResult<ToolSet, any, Output.Output<unknown, unknown, unknown>>
  >;
}

export function structuredOutput<
  TSchema extends FlexibleSchema,
  const TOOLS extends ToolSet = {},
>(
  options: StructuredOutputOptions<TSchema, TOOLS>,
): StructuredOutputResult<TSchema, TOOLS> {
  const tools = withHostOnlyToolMetadata({ ...options.tools });
  return {
    async generate(
      ...[callOptions]: ToolCallArguments<PreparedTools<TOOLS>, GenerateOptions>
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
        abortSignal: callOptions?.abortSignal,
        providerOptions: options.providerOptions,
        telemetry: options.telemetry,
        model: options.model,
        instructions: systemPrompt,
        messages: await convertToModelMessages(messages as never, {
          ignoreIncompleteToolCalls: true,
          tools,
        }),
        stopWhen: DEFAULT_STOP_WHEN,
        repairToolCall: createRepairToolCall(
          options.model,
          callOptions?.abortSignal,
        ),
        toolsContext: callOptions?.toolsContext as never,
        output: Output.object({ schema: options.schema }),
        tools,
      });

      return result.output as InferSchema<TSchema>;
    },

    async stream(
      ...[callOptions]: ToolCallArguments<PreparedTools<TOOLS>, StreamOptions>
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
        abortSignal: callOptions?.abortSignal,
        providerOptions: options.providerOptions,
        telemetry: options.telemetry,
        model: options.model,
        instructions: systemPrompt,
        repairToolCall: createRepairToolCall(
          options.model,
          callOptions?.abortSignal,
        ),
        messages: await convertToModelMessages(messages as never, {
          ignoreIncompleteToolCalls: true,
          tools,
        }),
        stopWhen: DEFAULT_STOP_WHEN,
        experimental_transform: callOptions?.transform ?? smoothStream(),
        toolsContext: callOptions?.toolsContext as never,
        output: Output.object({ schema: options.schema }),
        tools,
      });
    },
  };
}

/**
 * The stream chunk type is generic (`InferUIMessageChunk<UI_MESSAGE>`), so a
 * `type` check does not narrow it enough to reach `id`.
 */
function chunkId(chunk: unknown): string | undefined {
  if (typeof chunk !== 'object' || chunk === null || !('id' in chunk)) {
    return undefined;
  }
  const { id } = chunk as { id: unknown };
  return typeof id === 'string' ? id : undefined;
}

/**
 * Emit `text` as a completed text part.
 *
 * When `openPartId` is given, the feedback continues that already-open part and
 * closes it — a guardrail rejects mid-text, so its `text-start` is already on
 * the wire. Opening a second part instead would strand the first one in
 * `state: 'streaming'` forever in the persisted message.
 */
function writeText(
  writer: UIMessageStreamWriter,
  text: string,
  openPartId?: string,
) {
  const feedbackPartId = openPartId ?? generateId();
  if (openPartId === undefined) {
    writer.write({
      id: feedbackPartId,
      type: 'text-start',
    });
  }
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
