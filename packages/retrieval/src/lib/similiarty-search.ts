import { embedMany } from 'ai';

import { type IngestionConfig, ingest } from './ingest.js';

export async function similaritySearch(
  query: string,
  config: Omit<IngestionConfig, 'splitter'>,
) {
  // Ingest if needed, then perform vector similarity search via the configured store
  const mode = config.connector.ingestWhen ?? 'contentChanged';
  let shouldIngest = true;

  if (mode === 'never') {
    if (await config.store.sourceExists(config.connector.sourceId)) {
      console.log(
        `Skipping ingestion for source ${config.connector.sourceId} (ingestWhen=never and source exists)`,
      );
      shouldIngest = false;
    }
  } else if (mode === 'expired') {
    const sourceExists = await config.store.sourceExists(
      config.connector.sourceId,
    );
    if (
      sourceExists &&
      !(await config.store.sourceExpired(config.connector.sourceId))
    ) {
      console.log(
        `Skipping ingestion for source ${config.connector.sourceId} (ingestWhen=expired and source not expired)`,
      );
      shouldIngest = false;
    }
  }

  // Calculate expiry date if connector specifies expiresAfter
  const expiryDate = config.connector.expiresAfter
    ? new Date(Date.now() + config.connector.expiresAfter)
    : undefined;
  if (shouldIngest) {
    await ingest(config);
  }
  return config.store
    .search(
      query,
      { sourceId: config.connector.sourceId, topN: 10 },
      config.embedder,
    )
    .then(
      (results) =>
        results.map((it) => ({
          ...it,
          similarity: 1 - it.distance,
          distance: it.distance,
        })) as any[],
    );
}
