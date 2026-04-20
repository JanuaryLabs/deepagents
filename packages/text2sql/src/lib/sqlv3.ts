import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  type StreamTextTransform,
  ToolCallRepairError,
  type ToolSet,
  createUIMessageStream,
  generateId,
} from 'ai';

import { type AgentModel } from '@deepagents/agent';
import {
  type AgentSandbox,
  type ChatMessage,
  ContextEngine,
  type ContextFragment,
  agent,
  assistant,
  chatMessageToUIMessage,
  errorRecoveryGuardrail,
  generateChatTitle,
  staticChatTitle,
  toMessageFragment,
} from '@deepagents/context';

import type { Adapter } from './adapters/adapter.ts';
import { toSql } from './agents/sql.agent.ts';
import { JsonCache } from './file-cache.ts';
import { guidelines } from './instructions.ts';
import type { RenderingTools } from './sql.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';

export interface Text2SqlV3Config {
  adapter: Adapter;
  sandbox: AgentSandbox;
  context: (...fragments: ContextFragment[]) => ContextEngine;
  version: string;
  tools?: RenderingTools;
  model: AgentModel;
  transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
}

/**
 * Text2SqlV3 — the caller owns the sandbox. Unlike {@link Text2Sql} it does
 * not build a second just-bash internally. The caller is expected to wire the
 * sql command ({@link createSqlCommand}) plus {@link SqlBacktickRewritePlugin}
 * and {@link SqlProxyEnforcementPlugin} onto their own `Bash`, hand the
 * resulting `AgentSandbox` in, and Text2SqlV3 passes it to `agent()` unchanged.
 */
export class Text2SqlV3 {
  #config: Text2SqlV3Config & {
    introspection: JsonCache<ContextFragment[]>;
  };

  constructor(config: Text2SqlV3Config) {
    this.#config = {
      ...config,
      tools: config.tools ?? {},
      introspection: new JsonCache<ContextFragment[]>(
        'introspection-' + config.version,
      ),
    };
  }

  public async toSql(input: string): Promise<string> {
    const schemaFragments = await this.index();
    const result = await toSql({
      input,
      adapter: this.#config.adapter,
      fragments: schemaFragments,
      model: this.#config.model,
    });
    return result.sql;
  }

  /**
   * Introspect the database schema and return context fragments.
   * Results are cached to avoid repeated introspection.
   */
  public async index(): Promise<ContextFragment[]> {
    const cached = await this.#config.introspection.read();
    if (cached) {
      return cached;
    }
    const fragments = await this.#config.adapter.introspect();
    await this.#config.introspection.write(fragments);
    return fragments;
  }

  /**
   * Generate training data pairs using a producer factory.
   */
  public async toPairs<T extends PairProducer>(
    factory: (adapter: Adapter) => T,
  ): Promise<ExtractedPair[]> {
    const producer = factory(this.#config.adapter);
    return producer.toPairs();
  }

  public async chat(
    messages: ChatMessage[],
    options?: { abortSignal?: AbortSignal; generateTitle?: boolean },
  ) {
    if (messages.length === 0) {
      throw new Error('messages must not be empty');
    }

    const context = this.#config.context(
      ...guidelines(),
      ...(await this.index()),
    );

    const lastItem = messages[messages.length - 1];
    const lastFragment = toMessageFragment(lastItem);
    const lastUIMessage = chatMessageToUIMessage(lastItem);
    let assistantMsgId: string;

    if (lastUIMessage.role === 'assistant') {
      context.set(lastFragment);
      await context.save({ branch: false });
      assistantMsgId = lastUIMessage.id;
    } else {
      context.set(lastFragment);
      await context.save();
      assistantMsgId = generateId();
    }

    const uiMessages = messages.map(chatMessageToUIMessage);

    let title: string | null = null;
    if (!context.chat?.title) {
      const firstUserMsg = uiMessages.find((m) => m.role === 'user');
      if (firstUserMsg) {
        if (options?.generateTitle) {
          title = await generateChatTitle({
            message: firstUserMsg,
            model: this.#config.model,
            abortSignal: options?.abortSignal,
          });
        } else {
          title = staticChatTitle(firstUserMsg);
        }
        await context.updateChat({ title });
      }
    }

    const chatAgent = agent({
      name: 'text2sql',
      sandbox: this.#config.sandbox,
      model: this.#config.model,
      context,
      tools: this.#config.tools,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    const result = await chatAgent.stream(
      {},
      { abortSignal: options?.abortSignal, transform: this.#config.transform },
    );

    const uiStream = result.toUIMessageStream({
      onError: (error) => this.#formatError(error),
      sendStart: true,
      sendFinish: true,
      sendReasoning: true,
      sendSources: true,
      originalMessages: uiMessages,
      generateMessageId: () => assistantMsgId,
      messageMetadata: ({ part }) => {
        if (part.type === 'finish-step') {
          return {
            finishReason: part.finishReason,
            usage: part.usage,
          };
        }
        if (part.type === 'finish') {
          return {
            finishReason: part.finishReason,
            totalUsage: part.totalUsage,
          };
        }
        return undefined;
      },
    });

    return createUIMessageStream({
      originalMessages: uiMessages,
      generateId: () => assistantMsgId,
      onStepFinish: async ({ responseMessage }) => {
        context.set(assistant({ ...responseMessage, id: assistantMsgId }));
        await context.save({ branch: false });
      },
      onFinish: async ({ responseMessage }) => {
        const createdFiles = await collectCreatedFiles(result);
        context.set(
          assistant({
            ...responseMessage,
            id: assistantMsgId,
            metadata: {
              ...((responseMessage.metadata as object) ?? {}),
              createdFiles,
            },
          }),
        );
        await context.save({ branch: false });
        await context.trackUsage(await result.totalUsage);
      },
      execute: async ({ writer }) => {
        writer.merge(uiStream);

        if (title) {
          writer.write({ type: 'data-chat-title', data: title });
        }
      },
    });
  }

  #formatError(error: unknown): string {
    if (NoSuchToolError.isInstance(error)) {
      return 'The model tried to call an unknown tool.';
    } else if (InvalidToolInputError.isInstance(error)) {
      return 'The model called a tool with invalid arguments.';
    } else if (ToolCallRepairError.isInstance(error)) {
      return 'The model tried to call a tool with invalid arguments, but it was repaired.';
    } else if (APICallError.isInstance(error)) {
      console.error('Upstream API call failed:', error);
      return `Upstream API call failed with status ${(error as APICallError).statusCode}: ${(error as APICallError).message}`;
    }
    return JSON.stringify(error);
  }
}

/**
 * Walks `result.steps[].toolResults[].output.meta.resultPath` and collects
 * every sql run's result path. The bash-tool wrapper keeps `meta` on the raw
 * tool result even though `toModelOutput` strips it for the model. If the AI
 * SDK ever stops preserving `meta`, this returns [] and the assistant-message
 * metadata simply records an empty list.
 */
async function collectCreatedFiles(result: {
  steps: PromiseLike<readonly unknown[]> | readonly unknown[];
}): Promise<string[]> {
  const steps = (await result.steps) as readonly unknown[];
  const files: string[] = [];
  for (const step of steps) {
    const toolResults = (step as { toolResults?: unknown[] }).toolResults;
    if (!Array.isArray(toolResults)) continue;
    for (const tr of toolResults) {
      const output = (tr as { output?: unknown }).output;
      if (typeof output !== 'object' || output === null) continue;
      const meta = (output as { meta?: { resultPath?: unknown } }).meta;
      const p = meta?.resultPath;
      if (typeof p === 'string') files.push(p);
    }
  }
  return files;
}
