import { type AgentModel } from '@deepagents/agent';
import type { ContextFragment } from '@deepagents/context';

import {
  AdapterIndexer,
  type Text2SqlIndexProgressHandler,
} from './adapter-index.ts';
import { validateAdapterNames } from './adapter-name.ts';
import { type Adapter } from './adapters/adapter.ts';
import { toSql } from './agents/sql.agent.ts';
import { type ExtractedPair, type PairProducer } from './synthesis/types.ts';

export interface Text2SqlConfig {
  adapters: Record<string, Adapter>;
  version?: string;
  model?: AgentModel;
}

export interface Text2SqlRunResult {
  rows: unknown[];
  columns: string[];
}

export interface Text2SqlIndexOptions {
  names?: readonly string[];
  onProgress?: Text2SqlIndexProgressHandler;
}

const text2SqlValidationMarker = Symbol('Text2SqlValidationError');
const text2SqlUnknownAdapterMarker = Symbol('Text2SqlUnknownAdapterError');

export class Text2SqlValidationError extends Error {
  [text2SqlValidationMarker]: true;

  constructor(message: string) {
    super(message);
    this.name = 'Text2SqlValidationError';
    this[text2SqlValidationMarker] = true;
  }

  static isInstance(error: unknown): error is Text2SqlValidationError {
    return (
      error instanceof Text2SqlValidationError &&
      error[text2SqlValidationMarker] === true
    );
  }
}

export class Text2SqlUnknownAdapterError extends Error {
  [text2SqlUnknownAdapterMarker]: true;
  readonly adapter: string;
  readonly available: readonly string[];

  constructor(adapter: string, available: readonly string[]) {
    const list = available.join(', ') || '(none configured)';
    super(`Unknown adapter "${adapter}". Available: ${list}`);
    this.name = 'Text2SqlUnknownAdapterError';
    this.adapter = adapter;
    this.available = available;
    this[text2SqlUnknownAdapterMarker] = true;
  }

  static isInstance(error: unknown): error is Text2SqlUnknownAdapterError {
    return (
      error instanceof Text2SqlUnknownAdapterError &&
      error[text2SqlUnknownAdapterMarker] === true
    );
  }
}

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
      throw new Text2SqlUnknownAdapterError(name, this.adapterNames());
    }
    return adapter;
  }

  #requireModel(op: string): AgentModel {
    const model = this.#config.model;
    if (!model) {
      throw new Error(`Text2Sql.${op}() requires a model in Text2SqlConfig`);
    }
    return model;
  }

  adapterNames(): string[] {
    return Object.keys(this.#config.adapters);
  }

  hasAdapter(name: string): boolean {
    return name in this.#config.adapters;
  }

  async validate(name: string, sql: string): Promise<string> {
    const adapter = this.#requireAdapter(name);
    const result = this.#validateWith(adapter, sql);
    return result;
  }

  async run(name: string, sql: string): Promise<Text2SqlRunResult> {
    const adapter = this.#requireAdapter(name);
    const formatted = await this.#validateWith(adapter, sql);
    const result = await adapter.execute(formatted);
    if (!Array.isArray(result)) {
      throw new Error('adapter.execute must return an array of rows');
    }
    const columns = result.length > 0 ? Object.keys(result[0] as object) : [];
    return { rows: result, columns };
  }

  async #validateWith(adapter: Adapter, sql: string): Promise<string> {
    const formatted = adapter.format(sql);
    const error = await adapter.validate(formatted);
    if (error) throw new Text2SqlValidationError(error);
    return formatted;
  }

  async index(options: Text2SqlIndexOptions = {}): Promise<ContextFragment[]> {
    return this.#indexer.index({
      adapterNames: options.names,
      onProgress: options.onProgress,
    });
  }

  async toSql(input: string, adapterName: string): Promise<string> {
    const adapter = this.#requireAdapter(adapterName);
    const model = this.#requireModel('toSql');
    const fragments = await this.#indexer.indexAdapter(adapterName);
    const result = await toSql({
      input,
      adapter,
      fragments,
      model,
    });
    return result.sql;
  }

  async toPairs<T extends PairProducer>(
    adapterName: string,
    factory: (adapter: Adapter) => T,
  ): Promise<ExtractedPair[]> {
    const adapter = this.#requireAdapter(adapterName);
    const producer = factory(adapter);
    return producer.toPairs();
  }
}
