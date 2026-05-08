import type {
  GeneratorFragmentLoader,
  LoadContext,
  ValueResolver,
} from './types.ts';

export interface GeneratorResolverOptions {
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 10_000;

const GENERATOR_CTOR_NAMES = new Set([
  'GeneratorFunction',
  'AsyncGeneratorFunction',
]);

export class GeneratorResolver implements ValueResolver {
  readonly name = 'GeneratorResolver';
  readonly #maxItems: number;

  constructor(options: GeneratorResolverOptions = {}) {
    this.#maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  }

  canResolve(value: unknown): boolean {
    return (
      typeof value === 'function' &&
      GENERATOR_CTOR_NAMES.has(value.constructor.name)
    );
  }

  async resolve(value: unknown, ctx: LoadContext): Promise<unknown> {
    const iterable = (value as GeneratorFragmentLoader)(ctx);
    const collected: unknown[] = [];
    if (isAsyncIterable(iterable)) {
      for await (const chunk of iterable) {
        pushLimited(collected, chunk, this.#maxItems, this.name);
      }
    } else {
      for (const chunk of iterable) {
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
      `${resolverName}: generator yielded more than ${maxItems} items`,
    );
  }
  collected.push(chunk);
}
