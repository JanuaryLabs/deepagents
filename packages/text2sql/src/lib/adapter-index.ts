import { type ContextFragment, fragment } from '@deepagents/context';

import { validateAdapterNames } from './adapter-name.ts';
import {
  type Adapter,
  type IntrospectionPhase,
  type IntrospectionProgress,
} from './adapters/adapter.ts';
import { createGroundingContext } from './adapters/groundings/context.ts';
import { JsonCache } from './file-cache.ts';

export const TEXT2SQL_INDEX_PROGRESS_CHUNK = 'data-text2sql-index-progress';

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

export type Text2SqlIndexProgressHandler = (
  event: Text2SqlIndexProgressEvent,
) => void;

export interface AdapterIndexerOptions {
  adapters: Record<string, Adapter>;
  version?: string;
  cacheKey?: (adapterName: string) => string | undefined;
}

export interface AdapterIndexerIndexOptions {
  adapterNames?: readonly string[];
  onProgress?: Text2SqlIndexProgressHandler;
}

export interface AdapterIndexerAdapterOptions {
  onProgress?: Text2SqlIndexProgressHandler;
}

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

export class AdapterIndexer {
  readonly #adapters: Record<string, Adapter>;
  readonly #version: string | undefined;
  readonly #cacheKey: ((adapterName: string) => string | undefined) | undefined;

  constructor(options: AdapterIndexerOptions) {
    const adapterNames = Object.keys(options.adapters);
    if (adapterNames.length === 0) {
      throw new Error('AdapterIndexer requires at least one adapter');
    }

    validateAdapterNames(adapterNames);
    this.#adapters = options.adapters;
    this.#version = options.version;
    this.#cacheKey = options.cacheKey;
  }

  async index(
    options: AdapterIndexerIndexOptions = {},
  ): Promise<ContextFragment[]> {
    const progress = timestampProgressHandler(options.onProgress);
    const entries = this.#resolveIndexEntries(options.adapterNames);

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

  async indexAdapter(
    name: string,
    options: AdapterIndexerAdapterOptions = {},
  ): Promise<ContextFragment[]> {
    const adapter = this.#adapters[name];
    if (!adapter) {
      const available = Object.keys(this.#adapters).join(', ');
      throw new Error(`unknown adapter "${name}". Available: ${available}`);
    }

    return this.#indexAdapter(
      name,
      adapter,
      timestampProgressHandler(options.onProgress),
    );
  }

  async #indexAdapter(
    name: string,
    adapter: Adapter,
    progress: Text2SqlIndexProgressHandler,
  ): Promise<ContextFragment[]> {
    progress({
      type: 'adapter:start',
      adapter: name,
      message: `Indexing adapter "${name}"...`,
    });

    const cacheKey = this.#adapterCacheKey(name);
    const cache = cacheKey
      ? new JsonCache<ContextFragment[]>(cacheKey)
      : undefined;

    try {
      const cached = await cache?.read();
      if (cached) {
        progress({
          type: 'adapter:cache-hit',
          adapter: name,
          message: `Using cached index for adapter "${name}".`,
          cached: true,
        });
        progress({
          type: 'adapter:end',
          adapter: name,
          message: `Finished indexing adapter "${name}".`,
          cached: true,
        });
        return cached;
      }

      if (cache) {
        progress({
          type: 'adapter:cache-miss',
          adapter: name,
          message: `No cached index for adapter "${name}".`,
          cached: false,
        });
      }

      const ctx = createGroundingContext({
        onProgress: (event) => progress(adapterProgressEvent(name, event)),
      });
      const fragments = await adapter.introspect(ctx);
      await cache?.write(fragments);
      progress({
        type: 'adapter:end',
        adapter: name,
        message: `Finished indexing adapter "${name}".`,
        cached: false,
      });
      return fragments;
    } catch (error) {
      const reason = errorMessage(error);
      progress({
        type: 'adapter:error',
        adapter: name,
        message: `Failed indexing adapter "${name}": ${reason}`,
      });
      throw new Error(`introspecting adapter "${name}": ${reason}`, {
        cause: error,
      });
    }
  }

  #resolveIndexEntries(
    adapterNames: readonly string[] | undefined,
  ): Array<[string, Adapter]> {
    const availableNames = Object.keys(this.#adapters);
    const requestedNames =
      adapterNames && adapterNames.length > 0
        ? [...new Set(adapterNames)]
        : availableNames;
    const available = availableNames.join(', ');

    return requestedNames.map((name) => {
      const adapter = this.#adapters[name];
      if (!adapter) {
        throw new Error(`unknown adapter "${name}". Available: ${available}`);
      }
      return [name, adapter];
    });
  }

  #adapterCacheKey(name: string): string | undefined {
    const configured = this.#cacheKey?.(name);
    if (configured !== undefined) {
      return configured;
    }

    if (this.#version) {
      return `index-${this.#version}-${name}`;
    }

    return undefined;
  }
}

function adapterProgressEvent(
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
