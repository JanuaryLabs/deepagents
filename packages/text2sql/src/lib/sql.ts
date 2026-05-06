import {
  type StreamTextTransform,
  type Tool,
  type ToolSet,
  createUIMessageStream,
} from 'ai';

import { type AgentModel } from '@deepagents/agent';
import {
  type AgentSandbox,
  ContextEngine,
  type ContextFragment,
  agent,
  chat,
  errorRecoveryGuardrail,
  fragment,
} from '@deepagents/context';

import { validateAdapterNames } from './adapter-name.ts';
import {
  type Adapter,
  type IntrospectionPhase,
  type IntrospectionProgress,
} from './adapters/adapter.ts';
import { createGroundingContext } from './adapters/groundings/context.ts';
import { toSql } from './agents/sql.agent.ts';
import { JsonCache } from './file-cache.ts';
import { guidelines } from './instructions.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';

export type RenderingTools = Record<string, Tool<unknown, never>>;

export const TEXT2SQL_INDEX_PROGRESS_CHUNK =
  'data-text2sql-index-progress' as const;

export type Text2SqlIndexProgressEventType =
  | 'index:start'
  | 'index:end'
  | 'adapter:start'
  | 'adapter:end'
  | 'adapter:cache-hit'
  | 'adapter:cache-miss'
  | 'phase:start'
  | 'phase:progress'
  | 'phase:end'
  | 'adapter:error'
  | 'index:error';

export interface Text2SqlIndexProgressEvent {
  type: Text2SqlIndexProgressEventType;
  adapter?: string;
  phase?: IntrospectionPhase;
  table?: string;
  message: string;
  current?: number;
  total?: number;
  cached?: boolean;
  timestampMs?: number;
}

type Text2SqlIndexProgressHandler = (event: Text2SqlIndexProgressEvent) => void;

const noopProgressHandler: Text2SqlIndexProgressHandler = () => {};

function timestampProgressHandler(
  onProgress?: Text2SqlIndexProgressHandler,
): Text2SqlIndexProgressHandler {
  if (!onProgress) return noopProgressHandler;
  return (event) => {
    onProgress({
      ...event,
      timestampMs: event.timestampMs ?? Date.now(),
    });
  };
}

export interface Text2SqlConfig {
  adapters: Record<string, Adapter>;
  sandbox: AgentSandbox;
  /**
   * Context engine driving the conversation. Text2Sql appends its
   * guidelines and index fragments to this engine before each chat turn.
   * The same engine instance must be used for `continue()` calls upstream.
   */
  context: ContextEngine;
  version: string;
  tools?: RenderingTools;
  model: AgentModel;
  transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
}

/**
 * Text2Sql — the caller owns the sandbox. Build one by passing
 * `hostExtensions: [sqlSandboxExtension({ main: adapter }), ...yourOwnExtensions]`
 * to `createRoutingSandbox`, layered over whichever backend you want
 * (virtual, Docker, Agent OS), then wrap with `createBashTool`. For file
 * event tracking, wrap the fs in `ObservedFs` before passing to the
 * backend and attach `drainFileEvents: () => observed.drain()` to the
 * resulting sandbox.
 */
export class Text2Sql {
  #config: Omit<Text2SqlConfig, 'tools'> & {
    tools: RenderingTools;
  };
  #introspection: Map<string, JsonCache<ContextFragment[]>>;

  constructor(config: Text2SqlConfig) {
    const adapterNames = Object.keys(config.adapters);
    if (adapterNames.length === 0) {
      throw new Error('Text2Sql requires at least one adapter');
    }
    validateAdapterNames(adapterNames);
    this.#config = {
      ...config,
      tools: config.tools ?? {},
    };
    this.#introspection = new Map(
      Object.keys(config.adapters).map((name) => [
        name,
        new JsonCache<ContextFragment[]>(
          `introspection-${config.version}-${name}`,
        ),
      ]),
    );
  }

  #requireAdapter(name: string): Adapter {
    const adapter = this.#config.adapters[name];
    if (!adapter) {
      const available = Object.keys(this.#config.adapters).join(', ');
      throw new Error(`Unknown adapter "${name}". Available: ${available}`);
    }
    return adapter;
  }

  public async toSql(input: string, adapterName: string): Promise<string> {
    const adapter = this.#requireAdapter(adapterName);
    const fragments = await this.#indexAdapter(adapterName, adapter);
    const result = await toSql({
      input,
      adapter,
      fragments,
      model: this.#config.model,
    });
    return result.sql;
  }

  public async index(): Promise<ContextFragment[]> {
    return this.#index();
  }

  async #index(
    onProgress?: Text2SqlIndexProgressHandler,
  ): Promise<ContextFragment[]> {
    const progress = timestampProgressHandler(onProgress);
    const entries = Object.entries(this.#config.adapters);
    progress({
      type: 'index:start',
      message: `Indexing ${entries.length} adapter${entries.length === 1 ? '' : 's'}...`,
      current: 0,
      total: entries.length,
    });
    const settled = await Promise.allSettled(
      entries.map(async ([name, adapter]) => {
        const schema = await this.#indexAdapter(name, adapter, progress);
        return fragment(name, ...schema);
      }),
    );
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) {
      progress({
        type: 'index:error',
        message:
          failed.reason instanceof Error
            ? failed.reason.message
            : String(failed.reason),
      });
      throw failed.reason;
    }

    const wrapped = settled.map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      return result.value;
    });
    progress({
      type: 'index:end',
      message: 'Finished indexing adapters.',
      current: entries.length,
      total: entries.length,
    });
    return wrapped;
  }

  async #indexAdapter(
    name: string,
    adapter: Adapter,
    onProgress: Text2SqlIndexProgressHandler = noopProgressHandler,
  ): Promise<ContextFragment[]> {
    onProgress({
      type: 'adapter:start',
      adapter: name,
      message: `Indexing adapter "${name}"...`,
    });
    const cache = this.#introspection.get(name);
    if (!cache) {
      throw new Error(`no introspection cache registered for "${name}"`);
    }
    try {
      const cached = await cache.read();
      if (cached) {
        onProgress({
          type: 'adapter:cache-hit',
          adapter: name,
          message: `Using cached index for adapter "${name}".`,
          cached: true,
        });
        onProgress({
          type: 'adapter:end',
          adapter: name,
          message: `Finished indexing adapter "${name}".`,
          cached: true,
        });
        return cached;
      }
      onProgress({
        type: 'adapter:cache-miss',
        adapter: name,
        message: `No cached index for adapter "${name}".`,
        cached: false,
      });
      const ctx = createGroundingContext({
        onProgress: (event) =>
          onProgress(this.#adapterProgressEvent(name, event)),
      });
      const fragments = await adapter.introspect(ctx);
      await cache.write(fragments);
      onProgress({
        type: 'adapter:end',
        adapter: name,
        message: `Finished indexing adapter "${name}".`,
        cached: false,
      });
      return fragments;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onProgress({
        type: 'adapter:error',
        adapter: name,
        message: `Failed indexing adapter "${name}": ${reason}`,
      });
      throw new Error(`introspecting adapter "${name}": ${reason}`, {
        cause: error,
      });
    }
  }

  #adapterProgressEvent(
    adapter: string,
    progress: IntrospectionProgress,
  ): Text2SqlIndexProgressEvent {
    return {
      type: progress.type,
      adapter,
      phase: progress.phase,
      table: progress.table,
      message: progress.message,
      current: progress.current,
      total: progress.total,
      cached: false,
      timestampMs: progress.timestampMs,
    };
  }

  public async toPairs<T extends PairProducer>(
    adapterName: string,
    factory: (adapter: Adapter) => T,
  ): Promise<ExtractedPair[]> {
    const adapter = this.#requireAdapter(adapterName);
    const producer = factory(adapter);
    return producer.toPairs();
  }

  public async chat(options?: {
    abortSignal?: AbortSignal;
    generateTitle?: boolean;
  }) {
    return createUIMessageStream({
      execute: async ({ writer }) => {
        const context = this.#config.context;
        const head = await context.headMessage();
        if (!head || head.name !== 'assistant') {
          throw new Error(
            'text2sql.chat: expected head to be an assistant message — call context.continue() before chat()',
          );
        }
        writer.write({ type: 'start', messageId: head.id });

        const progress = (event: Text2SqlIndexProgressEvent) => {
          writer.write({
            type: TEXT2SQL_INDEX_PROGRESS_CHUNK,
            data: event,
          });
        };

        context.set(...guidelines(), ...(await this.#index(progress)));

        const chatAgent = agent({
          name: 'text2sql',
          sandbox: this.#config.sandbox,
          model: this.#config.model,
          context,
          tools: this.#config.tools,
          guardrails: [errorRecoveryGuardrail],
          maxGuardrailRetries: 3,
        });

        const chatStream = await chat(chatAgent, {
          abortSignal: options?.abortSignal,
          generateTitle: options?.generateTitle,
          transform: this.#config.transform,
        });

        writer.merge(chatStream);
      },
    });
  }
}
