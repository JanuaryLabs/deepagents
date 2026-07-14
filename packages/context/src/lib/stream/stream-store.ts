import type { StreamPart } from './types.ts';

export type { StreamPart } from './types.ts';

export type StreamStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ListStreamIdsOptions {
  status?: StreamStatus;
}

export interface StreamData {
  id: string;
  status: StreamStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelRequestedAt: number | null;
  error: string | null;
}

export type StreamUpdate = Partial<Omit<StreamData, 'id' | 'createdAt'>>;

export type StreamUpdater = (
  stream: Readonly<StreamData>,
) => StreamUpdate | undefined;

export interface StreamUpdateResult {
  stream: StreamData;
  updated: boolean;
}

export interface StreamChunkData {
  streamId: string;
  seq: number;
  data: StreamPart;
  createdAt: number;
}

export interface StreamFailure {
  streamId: string;
  error: string;
}

export function collectStreamFailures(
  chunks: StreamChunkData[],
): StreamFailure[] {
  const failures = new Map<string, string>();
  for (const chunk of chunks) {
    if (chunk.data.type === 'error' && !failures.has(chunk.streamId)) {
      failures.set(chunk.streamId, chunk.data.errorText);
    }
  }

  return [...failures].map(([streamId, error]) => ({ streamId, error }));
}

export abstract class StreamStore {
  abstract createStream(stream: StreamData): Promise<void>;

  abstract upsertStream(
    stream: StreamData,
  ): Promise<{ stream: StreamData; created: boolean }>;

  abstract getStream(streamId: string): Promise<StreamData | undefined>;

  abstract getStreamStatus(streamId: string): Promise<StreamStatus | undefined>;

  abstract listStreamIds(options?: ListStreamIdsOptions): Promise<string[]>;

  async listRunningStreamIds(): Promise<string[]> {
    return this.listStreamIds({ status: 'running' });
  }

  /**
   * Atomically read and conditionally update a stream while holding the
   * store's write lock for that stream. Concurrent calls for the same stream
   * must observe one another's committed updates.
   *
   * The updater is synchronous and should be free of side effects. Return
   * `undefined` to leave the stream unchanged. `updated` reports whether this
   * caller persisted an update.
   */
  abstract updateStream(
    streamId: string,
    update: StreamUpdater,
  ): Promise<StreamUpdateResult>;

  abstract updateStreamStatus(
    streamId: string,
    status: StreamStatus,
    options?: { error?: string },
  ): Promise<void>;

  abstract appendChunks(chunks: StreamChunkData[]): Promise<void>;

  abstract getChunks(
    streamId: string,
    fromSeq?: number,
    limit?: number,
  ): Promise<StreamChunkData[]>;

  abstract deleteStream(streamId: string): Promise<void>;

  abstract reopenStream(streamId: string): Promise<StreamData>;
}
