interface ConnectorSource {
  /**
   * List of corpuses
   */
  sources: () => AsyncGenerator<
    {
      id: string;
      content: () => Promise<string>;
      metadata?: Record<string, unknown> | undefined; // Arbitrary per-document metadata
    },
    void,
    unknown
  >;
  /** Unique identifier for the logical source (group of documents) used in the embedding store. */
  sourceId: string;
}

/**
 * Controls ingestion behavior:
 * - 'never': perform ingestion only if the source does NOT yet exist; once created, never re-ingest
 * - 'contentChanged': (default) run ingestion; underlying pipeline will skip unchanged documents
 * - 'expired': only ingest if source doesn't exist OR is expired
 *
 * Only the 'expired' mode reads the time, so only it has an expiry and a clock.
 */
export type IngestPolicy =
  | { ingestWhen?: 'never' | 'contentChanged' }
  | {
      ingestWhen: 'expired';
      /**
       * Optional expiry duration in milliseconds from now.
       * When set, the source will be considered expired after this duration.
       */
      expiresAfter?: number;
      /** An entry gives `globalThis`; a test gives `createClock()`. */
      clock: { Date: { now(): number } };
    };

export type Connector = ConnectorSource & IngestPolicy;
