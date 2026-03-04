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

export interface StreamChunkData {
  streamId: string;
  seq: number;
  data: unknown;
  createdAt: number;
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
