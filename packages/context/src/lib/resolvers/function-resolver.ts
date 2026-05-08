import type {
  LoadContext,
  SyncFragmentLoader,
  ValueResolver,
} from './types.ts';

export class FunctionResolver implements ValueResolver {
  readonly name = 'FunctionResolver';

  canResolve(value: unknown): boolean {
    return typeof value === 'function';
  }

  async resolve(value: unknown, ctx: LoadContext): Promise<unknown> {
    const loader = value as SyncFragmentLoader;
    return loader(ctx);
  }
}
