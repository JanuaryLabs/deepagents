import { isFragment } from '../fragments.ts';
import type { LoadContext, ValueResolver } from './types.ts';

export interface IterableResolverOptions {
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 10_000;

function hasIterableProtocol(
  value: object,
): value is AsyncIterable<unknown> | Iterable<unknown> {
  return Symbol.asyncIterator in value || Symbol.iterator in value;
}

function isBoxedPrimitive(value: object): boolean {
  return (
    value instanceof String ||
    value instanceof Number ||
    value instanceof Boolean
  );
}

export class IterableResolver implements ValueResolver {
  readonly name = 'IterableResolver';
  readonly #maxItems: number;

  constructor(options: IterableResolverOptions = {}) {
    this.#maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  }

  canResolve(
    value: unknown,
  ): value is AsyncIterable<unknown> | Iterable<unknown> {
    if (value === null || value === undefined) return false;
    if (typeof value !== 'object') return false;
    if (Array.isArray(value)) return false;
    if (value instanceof Promise) return false;
    if (isBoxedPrimitive(value)) return false;
    if (isFragment(value)) return false;
    return hasIterableProtocol(value);
  }

  async resolve(value: unknown, _ctx: LoadContext): Promise<unknown> {
    if (!this.canResolve(value)) {
      throw new TypeError(`${this.name} cannot resolve a ${typeof value}`);
    }
    const collected: unknown[] = [];
    if (isAsyncIterable(value)) {
      for await (const chunk of value) {
        pushLimited(collected, chunk, this.#maxItems, this.name);
      }
    } else {
      for (const chunk of value) {
        pushLimited(collected, chunk, this.#maxItems, this.name);
      }
    }
    return collected;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

function pushLimited(
  collected: unknown[],
  chunk: unknown,
  maxItems: number,
  resolverName: string,
): void {
  if (collected.length >= maxItems) {
    throw new Error(
      `${resolverName}: iterable yielded more than ${maxItems} items`,
    );
  }
  collected.push(chunk);
}
