import type {
  LoadContext,
  SyncFragmentLoader,
  ValueResolver,
} from './types.ts';

export class FunctionResolver implements ValueResolver {
  readonly name = 'FunctionResolver';
  readonly requiresSandbox = true;

  canResolve(value: unknown): value is SyncFragmentLoader {
    return typeof value === 'function';
  }

  async resolve(value: unknown, ctx: LoadContext): Promise<unknown> {
    if (!this.canResolve(value)) {
      throw new TypeError(`${this.name} cannot resolve a ${typeof value}`);
    }
    return value(ctx);
  }
}
