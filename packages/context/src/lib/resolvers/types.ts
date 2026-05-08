import type { ContextEngine } from '../engine.ts';
import type { FragmentData } from '../fragments.ts';
import type { AgentSandbox } from '../sandbox/types.ts';

export interface LoadContext {
  sandbox: AgentSandbox;
  context: ContextEngine;
  signal?: AbortSignal;
}

export type AsyncFragmentLoader = (ctx: LoadContext) => Promise<FragmentData>;
export type SyncFragmentLoader = (ctx: LoadContext) => FragmentData;
export type GeneratorFragmentLoader = (
  ctx: LoadContext,
) => AsyncIterable<FragmentData> | Iterable<FragmentData>;

export interface ValueResolver {
  readonly name: string;
  canResolve(value: unknown): boolean;
  /**
   * Returns the materialized value. Typed `unknown` (not `FragmentData`) to avoid
   * TypeScript's recursive-promise inference blowup — callers cast at the boundary.
   * The walker re-feeds this through `walkData`, so recursive lazy values are still resolved.
   */
  resolve(value: unknown, ctx: LoadContext): Promise<unknown>;
}
