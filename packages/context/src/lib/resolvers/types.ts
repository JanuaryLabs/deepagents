import type { ContextEngine } from '../engine.ts';
import type { AgentSandbox } from '../sandbox/types.ts';

export interface LoadContext {
  sandbox: AgentSandbox;
  context: ContextEngine;
  signal?: AbortSignal;
}

/**
 * Loader functions return `unknown` (not `FragmentData`) because `FragmentData`'s
 * inclusion of `Promise<unknown>`/`AsyncIterable<unknown>` makes TypeScript's
 * recursive-promise inference blow up at the boundary. The walker re-feeds every
 * loader result through `walkData`, so any nested lazy values still get materialized.
 */
export type AsyncFragmentLoader = (ctx: LoadContext) => Promise<unknown>;
export type SyncFragmentLoader = (ctx: LoadContext) => unknown;
export type GeneratorFragmentLoader = (
  ctx: LoadContext,
) => AsyncIterable<unknown> | Iterable<unknown>;

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
