import { validateTypes } from '@ai-sdk/provider-utils';
import { uiMessageChunkSchema } from 'ai';
import { z } from 'zod';

import type { StreamPart, StreamStatus } from './stream-store.ts';

/** The values the streams.status CHECK constraint allows. */
export const streamStatus = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]) satisfies z.ZodType<StreamStatus>;

/**
 * Checks a stored chunk against the AI SDK's UI message chunk schema, the
 * same check the SDK's chat transport applies to chunks it receives.
 */
export function toStreamPart(value: unknown): Promise<StreamPart> {
  return validateTypes({ value, schema: uiMessageChunkSchema });
}
