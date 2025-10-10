import { groq } from '@ai-sdk/groq';

import {
  type IngestionConfig,
  nodeSQLite,
  similaritySearch,
} from '@agent/retrieval';
import * as connectors from '@agent/retrieval/connectors';

import { agent } from './agent.ts';
import { embed } from './models.ts';
import { printer } from './stream_utils.ts';
import { execute } from './swarm.ts';

/**
 * Retrieval-Augmented Generation (RAG) function that ingests content from a connector,
 * searches for relevant information, and generates responses using an AI agent.
 *
 * Ingestion: Uses the provided connector to fetch sources and (re)ingest their content into the selected store.
 * Search: Performs a similarity search over the store using the provided embedder and splitter (defaults provided).
 * Generation: Feeds the retrieved context to an AI agent to generate an answer.
 *
 * @param query - The user question or prompt about the ingested content.
 * @param config - Configuration containing connector, store, and optional splitter/embedder overrides.
 * @returns A stream of generated responses from the AI agent.
 *
 * @example
 * // GitHub file analysis
 * const stream = await rag(
 *   'Who is the protagonist in the story and what happens to him?',
 *   {
 *     connector: connectors.github('mlschmitt/classic-books-markdown/Franz Kafka/The Trial.md'),
 *     store: sqlite,
 *   },
 * );
 *
 * @example
 * // RSS feed analysis
 * const stream = await rag(
 *   'What are the latest developments in AI?',
 *   {
 *     connector: connectors.rss('https://hnrss.org/frontpage'),
 *     store: sqlite,
 *   },
 * );
 */
async function rag(query: string, config: IngestionConfig) {
  const results = await similaritySearch(query, config);
  const kafka = agent({
    name: 'Kafka',
    model: groq('moonshotai/kimi-k2-instruct-0905'),
    // model: lmstudio('qwen3-0.6b'),
    prompt: `${results.map((r, index) => `Source: ${index}\nContent: ${r.content}`).join('\n\n')}`,
    temperature: 0.2,
  });
  return execute(kafka, query, {});
}

if (import.meta.main) {
  const stream = await rag('What did the agent failed at', {
    connector: connectors.local('**/*.md', {
      ingestWhen: 'expired',
      expiresAfter: 1000 * 60 * 60 * 24, // 1 day
    }),
    store: nodeSQLite(348),
    embedder: embed,
  });
  printer.stdout(stream);
}
