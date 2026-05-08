import type { FragmentData } from '../fragments.ts';
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

  resolve(value: unknown, ctx: LoadContext): Promise<unknown> {
    return Promise.resolve((value as SyncFragmentLoader)(ctx));
  }
}
