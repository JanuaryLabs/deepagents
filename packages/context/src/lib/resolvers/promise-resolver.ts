import type { LoadContext, ValueResolver } from './types.ts';

export class PromiseResolver implements ValueResolver {
  readonly name = 'PromiseResolver';

  canResolve(value: unknown): boolean {
    return value instanceof Promise;
  }

  resolve(value: unknown, _ctx: LoadContext): Promise<unknown> {
    return value as Promise<unknown>;
  }
}
