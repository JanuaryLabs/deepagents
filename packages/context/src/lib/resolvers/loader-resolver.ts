import {
  type ContextFragment,
  type FragmentData,
  type FragmentObject,
  isFragment,
  isFragmentObject,
} from '../fragments.ts';
import type { LoadContext, ValueResolver } from './types.ts';

export interface FragmentLoaderResolverOptions {
  maxDepth?: number;
}

const ROOT_PATH = '<root>';

export class FragmentLoaderResolver {
  readonly #resolvers: ValueResolver[];
  readonly #maxDepth: number;

  constructor(
    resolvers: ValueResolver[],
    options: FragmentLoaderResolverOptions = {},
  ) {
    this.#resolvers = resolvers;
    this.#maxDepth = options.maxDepth ?? 10;
  }

  async resolve(fragments: ContextFragment[], ctx: LoadContext): Promise<void> {
    await Promise.all(
      fragments.map((f) => this.#walkFragment(f, ctx, 0, new Set(), f.name)),
    );
  }

  async #walkFragment(
    fragment: ContextFragment,
    ctx: LoadContext,
    depth: number,
    ancestors: Set<object>,
    path: string,
  ): Promise<void> {
    if (!('data' in fragment)) return;
    fragment.data = (await this.#walkData(
      fragment.data,
      ctx,
      depth,
      ancestors,
      path,
    )) as FragmentData;
  }

  async #walkData(
    value: unknown,
    ctx: LoadContext,
    depth: number,
    ancestors: Set<object>,
    path: string,
  ): Promise<unknown> {
    if (ctx.signal?.aborted) {
      throw ctx.signal.reason ?? new Error('Resolver aborted');
    }
    if (depth > this.#maxDepth) {
      throw new Error(
        `Resolver recursion exceeded maxDepth=${this.#maxDepth} at fragment '${path}'`,
      );
    }

    const handler = this.#resolvers.find((r) => r.canResolve(value));
    if (handler) {
      let resolved: unknown;
      try {
        resolved = await this.#raceWithSignal(
          handler.resolve(value, ctx),
          ctx.signal,
        );
      } catch (cause) {
        throw new Error(
          `Async fragment '${path}' failed in ${handler.name}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        );
      }
      return this.#walkData(resolved, ctx, depth + 1, ancestors, path);
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (isFragment(value)) {
      if (ancestors.has(value)) return undefined;
      const childAncestors = new Set(ancestors);
      childAncestors.add(value);
      const childPath = `${path}.${value.name}`;
      await this.#walkFragment(
        value,
        ctx,
        depth + 1,
        childAncestors,
        childPath,
      );
      return value;
    }

    if (Array.isArray(value)) {
      if (ancestors.has(value)) return undefined;
      const childAncestors = new Set(ancestors);
      childAncestors.add(value);
      return Promise.all(
        value.map((item) =>
          this.#walkData(item, ctx, depth, childAncestors, path),
        ),
      );
    }

    if (isFragmentObject(value)) {
      if (ancestors.has(value)) return undefined;
      const childAncestors = new Set(ancestors);
      childAncestors.add(value);
      const out: FragmentObject = {};
      const entries = Object.entries(value);
      const resolvedValues = await Promise.all(
        entries.map(([, v]) =>
          this.#walkData(v, ctx, depth, childAncestors, path),
        ),
      );
      for (let i = 0; i < entries.length; i += 1) {
        const [k] = entries[i];
        const v = resolvedValues[i] as FragmentData | undefined;
        if (v !== undefined) out[k] = v;
      }
      return out;
    }

    return value;
  }

  #raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new Error('Resolver aborted'));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () =>
        reject(signal.reason ?? new Error('Resolver aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }
}

export { ROOT_PATH };
