import type { FragmentData } from '../fragments.ts';
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
    for await (const chunk of iterable) {
      if (collected.length >= this.#maxItems) {
        throw new Error(
          `GeneratorResolver: generator yielded more than ${this.#maxItems} items`,
        );
      }
      collected.push(chunk);
    }
    return collected;
  }
}
