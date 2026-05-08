import { AsyncResolver } from './async-resolver.ts';
import { FunctionResolver } from './function-resolver.ts';
import { GeneratorResolver } from './generator-resolver.ts';
import { IterableResolver } from './iterable-resolver.ts';
import { PromiseResolver } from './promise-resolver.ts';
import type { ValueResolver } from './types.ts';

export { AsyncResolver } from './async-resolver.ts';
export { FunctionResolver } from './function-resolver.ts';
export { GeneratorResolver } from './generator-resolver.ts';
export { IterableResolver } from './iterable-resolver.ts';
export { PromiseResolver } from './promise-resolver.ts';
export {
  FragmentLoaderResolver,
  type FragmentLoaderResolverOptions,
} from './loader-resolver.ts';
export type {
  AsyncFragmentLoader,
  GeneratorFragmentLoader,
  LoadContext,
  SyncFragmentLoader,
  ValueResolver,
} from './types.ts';

export function defaultResolvers(): ValueResolver[] {
  return [
    new AsyncResolver(),
    new GeneratorResolver(),
    new FunctionResolver(),
    new PromiseResolver(),
    new IterableResolver(),
  ];
}
