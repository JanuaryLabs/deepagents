export type Connector = {
  /**
   * List of corpuses
   */
  sources: () => AsyncGenerator<
    {
      id: string;
      content: () => Promise<string>;
      metadata?: Record<string, any> | undefined; // Arbitrary per-document metadata
    },
    void,
    unknown
  >;
  /** Unique identifier for the logical source (group of documents) used in the embedding store. */
  sourceId: string;
  /**
   * Controls ingestion behavior:
   * - 'never': perform ingestion only if the source does NOT yet exist; once created, never re-ingest
   * - 'contentChanged': (default) run ingestion; underlying pipeline will skip unchanged documents
   * - 'expired': only ingest if source doesn't exist OR is expired
   */
  ingestWhen?: 'never' | 'contentChanged' | 'expired';
  /**
   * Optional expiry duration in milliseconds from now.
   * When set, the source will be considered expired after this duration.
   */
  expiresAfter?: number;
};
