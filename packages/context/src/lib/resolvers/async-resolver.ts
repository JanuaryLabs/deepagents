import type {
  AsyncFragmentLoader,
  LoadContext,
  ValueResolver,
} from './types.ts';

export class AsyncResolver implements ValueResolver {
  readonly name = 'AsyncResolver';
  readonly requiresSandbox = true;

  canResolve(value: unknown): value is AsyncFragmentLoader {
    return (
      typeof value === 'function' && value.constructor.name === 'AsyncFunction'
    );
  }

  async resolve(value: unknown, ctx: LoadContext): Promise<unknown> {
    if (!this.canResolve(value)) {
      throw new TypeError(`${this.name} cannot resolve a ${typeof value}`);
    }
    return value(ctx);
  }
}
