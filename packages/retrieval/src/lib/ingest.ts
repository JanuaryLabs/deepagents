import {
  MarkdownTextSplitter,
  RecursiveCharacterTextSplitter,
} from 'langchain/text_splitter';

import type { Connector } from './connectors/connector.js';
import type { Splitter } from './pipeline.js';
import { cid } from './stores/cid.js';
import type { Embedder, Store } from './stores/store.js';

export interface IngestionConfig {
  connector: Connector;
  store: Store;
  splitter?: Splitter;
  embedder: Embedder;
}

export async function ingest(
  config: IngestionConfig,
  callback?: (it: string) => void,
) {
  const splitter = config.splitter ?? split;
  const embedder = config.embedder;
  const corpuses = config.connector.sources();

  for await (const it of corpuses) {
    callback?.(it.id);
    const content = await it.content();
    if (!content.trim()) {
      // skip empty files
      continue;
    }
    await config.store.index(config.connector.sourceId, {
      id: it.id,
      cid: cid(content),
      metadata: it.metadata,
      chunker: async function* () {
        // Embed in small batches to control memory usage
        const values = await splitter(it.id, content);
        const batchSize = 40;
        for (let i = 0; i < values.length; i += batchSize) {
          const batch = values.slice(i, i + batchSize);
          const { embeddings } = await embedder(batch);
          for (let j = 0; j < embeddings.length; j++) {
            yield {
              content: batch[j],
              embedding: embeddings[j],
            };
          }
        }
      },
    });
  }
}

function split(id: string, content: string) {
  const splitter = new MarkdownTextSplitter();
  return splitter.splitText(content);
}

export type ChunkPosition = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type SplitChunkWithPosition = {
  content: string;
  position: ChunkPosition | null;
  index: number;
};

function normalizeNewlines(value: string) {
  return value.replace(/\r\n/g, '\n');
}

function computePositions(
  originalContent: string,
  chunks: string[],
): Array<ChunkPosition | null> {
  if (!chunks.length) {
    return [];
  }

  const normalizedContent = normalizeNewlines(originalContent);
  const positions: Array<ChunkPosition | null> = [];
  let searchOffset = 0;

  for (const chunk of chunks) {
    const normalizedChunk = normalizeNewlines(chunk);
    const trimmedChunk = normalizedChunk.trim();

    const seek = (needle: string, fromIndex: number) =>
      needle ? normalizedContent.indexOf(needle, fromIndex) : -1;

    let matchIndex = seek(normalizedChunk, searchOffset);
    let matchValue = normalizedChunk;

    if (matchIndex === -1 && trimmedChunk) {
      matchIndex = seek(trimmedChunk, searchOffset);
      matchValue = trimmedChunk;
    }

    if (matchIndex === -1) {
      matchIndex = seek(normalizedChunk, 0);
      matchValue = normalizedChunk;
    }

    if (matchIndex === -1 && trimmedChunk) {
      matchIndex = seek(trimmedChunk, 0);
      matchValue = trimmedChunk;
    }

    if (matchIndex === -1) {
      positions.push(null);
      continue;
    }

    const before = normalizedContent.slice(0, matchIndex);
    const beforeLines = before.split('\n');
    const startLine = beforeLines.length;
    const startColumn = beforeLines[beforeLines.length - 1].length + 1;

    const lines = matchValue.split('\n');
    const endLine = startLine + lines.length - 1;
    const endColumn =
      lines.length === 1
        ? startColumn + lines[0].length
        : lines[lines.length - 1].length + 1;

    positions.push({ startLine, startColumn, endLine, endColumn });
    searchOffset = matchIndex + matchValue.length;
  }

  return positions;
}

function buildChunksWithPositions(
  originalContent: string,
  chunks: string[],
): SplitChunkWithPosition[] {
  const positions = computePositions(originalContent, chunks);
  return chunks.map((content, index) => ({
    content,
    index,
    position: positions[index] ?? null,
  }));
}

export async function splitTypeScriptWithPositions(
  id: string,
  content: string,
): Promise<SplitChunkWithPosition[]> {
  const splitter = RecursiveCharacterTextSplitter.fromLanguage('js', {
    chunkSize: 512,
    chunkOverlap: 100,
  });
  const docs = await splitter.createDocuments([content]);
  const chunks = docs.map((d) => d.pageContent);
  return buildChunksWithPositions(content, chunks);
}

export async function splitTypeScript(id: string, content: string) {
  const chunks = await splitTypeScriptWithPositions(id, content);
  return chunks.map((chunk) => chunk.content);
}
