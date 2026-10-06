import type { LoadContext, ValueResolver } from './types.ts';

export class PromiseResolver implements ValueResolver {
  readonly name = 'PromiseResolver';

  canResolve(value: unknown): value is Promise<unknown> {
    return value instanceof Promise;
  }

  async resolve(value: unknown, _ctx: LoadContext): Promise<unknown> {
    if (!this.canResolve(value)) {
      throw new TypeError(`${this.name} cannot resolve a ${typeof value}`);
    }
    return value;
  }
}
