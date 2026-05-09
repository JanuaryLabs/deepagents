import { type AgentModel } from '@deepagents/agent';

import { AdapterIndexer } from './adapter-index.ts';
import { validateAdapterNames } from './adapter-name.ts';
import { type Adapter } from './adapters/adapter.ts';
import { toSql } from './agents/sql.agent.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';

export interface Text2SqlConfig {
  adapters: Record<string, Adapter>;
  version: string;
  model: AgentModel;
}

/**
 * Stateless `toSql` for one or more configured adapters.
 * Build the streaming chat agent yourself with `agent` + `chat` from
 * `@deepagents/context`, passing `instructions()` and fragments from
 * `AdapterIndexer` into the engine.
 */
export class Text2Sql {
  #config: Text2SqlConfig;
  #indexer: AdapterIndexer;

  constructor(config: Text2SqlConfig) {
    const adapterNames = Object.keys(config.adapters);
    if (adapterNames.length === 0) {
      throw new Error('Text2Sql requires at least one adapter');
    }
    validateAdapterNames(adapterNames);
    this.#config = config;
    this.#indexer = new AdapterIndexer({
      adapters: config.adapters,
      version: config.version,
    });
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
    const fragments = await this.#indexer.indexAdapter(adapterName);
    const result = await toSql({
      input,
      adapter,
      fragments,
      model: this.#config.model,
    });
    return result.sql;
  }

  public async toPairs<T extends PairProducer>(
    adapterName: string,
    factory: (adapter: Adapter) => T,
  ): Promise<ExtractedPair[]> {
    const adapter = this.#requireAdapter(adapterName);
    const producer = factory(adapter);
    return producer.toPairs();
  }
}
