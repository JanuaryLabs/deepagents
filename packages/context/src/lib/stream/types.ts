import type { InferUIMessageChunk, UIDataTypes, UIMessage } from 'ai';

/**
 * Type alias for stream parts from the AI SDK's UI message stream.
 * This is the full chunk type that includes text-delta, error, reasoning-delta, etc.
 */
export type StreamPart = InferUIMessageChunk<
  UIMessage<unknown, UIDataTypes, Record<string, never>>
>;
