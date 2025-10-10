import type { Embedding } from 'ai';

export type Chunk = {
  content: string;
  embedding: Embedding | Float32Array;
};
export type Embedder = (documents: string[]) => Promise<{
  embeddings: (Embedding | Float32Array)[];
  dimensions: number;
}>;

export interface SearchOptions {
  sourceId: string;
  // FIXME: rename it to corpus id
  documentId?: string;
  topN?: number;
}

export type Corpus = {
  id: string;
  cid: string;
  chunker: () => AsyncGenerator<Chunk>;
  metadata?: Record<string, any> | undefined;
};

export interface Store {
  search: (
    query: string,
    options: SearchOptions,
    embedder: Embedder,
  ) => Promise<any[]>;
  sourceExists: (sourceId: string) => Promise<boolean> | boolean;
  sourceExpired: (sourceId: string) => Promise<boolean> | boolean;
  setSourceExpiry: (sourceId: string, expiryDate: Date) => Promise<void> | void;
  index: (
    sourceId: string,
    corpus: Corpus,
    expiryDate?: Date,
  ) => Promise<void>;
}
