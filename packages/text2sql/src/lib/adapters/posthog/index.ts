import type { Adapter } from '../adapter.ts';
import {
  PostHogDefinitionsGrounding,
  type PostHogDefinitionsGroundingConfig,
} from './definitions.posthog.grounding.ts';
import { PostHogInfoGrounding } from './info.posthog.grounding.ts';
import { PostHog } from './posthog.ts';
import {
  PostHogSchemaGrounding,
  type PostHogSchemaGroundingConfig,
} from './schema.posthog.grounding.ts';

export * from './definitions.posthog.grounding.ts';
export * from './posthog.sql-policy.ts';
export * from './posthog.ts';
export * from './schema.posthog.grounding.ts';
export * from './transport.ts';
export * from './types.ts';

export function info() {
  return () => new PostHogInfoGrounding();
}

export function schema(config: PostHogSchemaGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new PostHogSchemaGrounding(adapter as PostHog, config);
}

export function definitions(config: PostHogDefinitionsGroundingConfig = {}) {
  return (adapter: Adapter) =>
    new PostHogDefinitionsGrounding(adapter as PostHog, config);
}

export default {
  PostHog,
  definitions,
  info,
  schema,
};
