import type { ContextEngine } from '../engine.ts';
import type { AgentSandbox } from '../sandbox/types.ts';

export interface LoadContext {
  /**
   * Sandbox available to loaders for IO. Optional — required only when a
   * resolver with `requiresSandbox = true` is dispatched. The walker throws a
   * clear error in that case if the sandbox is absent.
   */
  sandbox?: AgentSandbox;
  /**
   * The owning engine. Optional in `LoadContext` so unit tests of resolvers
   * don't need to construct a real engine — production callsites (engine.resolve
   * and engine.estimate) always pass `this`, so loaders can safely use
   * `ctx.context!` when they need it.
   */
  context?: ContextEngine;
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
  /**
   * When true, the walker throws if this resolver is dispatched without a
   * sandbox in `LoadContext`. Default false (Promise/Iterable resolvers don't
   * touch the sandbox). Function-bodied resolvers (async/sync/generator) set
   * this to true so loaders can safely access `ctx.sandbox` in their bodies.
   */
  readonly requiresSandbox?: boolean;
  canResolve(value: unknown): boolean;
  /**
   * Returns the materialized value. Typed `unknown` (not `FragmentData`) to avoid
   * TypeScript's recursive-promise inference blowup — callers cast at the boundary.
   * The walker re-feeds this through `walkData`, so recursive lazy values are still resolved.
   */
  resolve(value: unknown, ctx: LoadContext): Promise<unknown>;
}
