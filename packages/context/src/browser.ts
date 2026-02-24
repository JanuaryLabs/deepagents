/**
 * Browser-focused entrypoint.
 *
 * This surface excludes server-only modules (stores, sandbox, skills loader)
 * and only exports APIs that are safe to consume in browser bundles.
 */
export * from './lib/codec.ts';
export * from './lib/estimate.ts';
export * from './lib/fragments.ts';
export * from './lib/fragments/domain.ts';
export * from './lib/fragments/message/user.ts';
export * from './lib/fragments/user.ts';
export * from './lib/guardrail.ts';
export * from './lib/models.generated.ts';
export * from './lib/render.ts';
export * from './lib/renderers/abstract.renderer.ts';
export * from './lib/soul/fragments.ts';
export * from './lib/store/store.ts';
export * from './lib/stream-buffer.ts';
export * from './lib/stream/stream-store.ts';
export * from './lib/visualize.ts';
