import type {
  AsyncFragmentLoader,
  LoadContext,
  ValueResolver,
} from './types.ts';

export class AsyncResolver implements ValueResolver {
  readonly name = 'AsyncResolver';
  readonly requiresSandbox = true;

  canResolve(value: unknown): boolean {
    return (
      typeof value === 'function' && value.constructor.name === 'AsyncFunction'
    );
  }

  resolve(value: unknown, ctx: LoadContext): Promise<unknown> {
    return (value as AsyncFragmentLoader)(ctx);
  }
}
