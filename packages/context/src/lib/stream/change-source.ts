export type StreamChange =
  | { kind: 'chunks' }
  | { kind: 'status' }
  | { kind: 'tick' };

export interface StreamChangeSource {
  subscribe(streamId: string, signal: AbortSignal): AsyncIterable<StreamChange>;
}
