import type {
  FeatureExtractionPipeline,
  Tensor,
} from '@huggingface/transformers';

import type { Embedder } from '../stores/store.js';

export type FeatureExtractionFn = FeatureExtractionPipeline;

export interface EmbeddingOptions {
  extractorFn: () =>
    | Promise<FeatureExtractionPipeline>
    | FeatureExtractionPipeline;
  pooling?: 'mean' | 'cls';
  normalize?: boolean;
}

async function textEmbeddings(
  inputs: string | string[],
  { extractorFn, pooling, normalize }: EmbeddingOptions,
) {
  inputs = (Array.isArray(inputs) ? inputs : [inputs]).map((it) => it.trim());
  const extractor = await extractorFn();
  const tensor = await extractor(inputs, {
    pooling: pooling ?? 'mean',
    normalize: normalize ?? true,
  });
  return tensorToEmbeddings(tensor);
}

export function tensorToEmbeddings(tensor: Tensor) {
  const dims = tensor.dims;
  if (!Array.isArray(dims) || dims.length < 2) {
    throw new Error(`Unexpected tensor dims: ${JSON.stringify(dims)}`);
  }
  const batchSize = dims[0];
  const hiddenSize = dims[dims.length - 1];
  const expectedLen = batchSize * hiddenSize;
  if (tensor.data.length !== expectedLen) {
    throw new Error(
      `Data length mismatch: got ${tensor.data.length}, expected ${expectedLen} (batch=${batchSize}, hidden=${hiddenSize})`,
    );
  }
  // Reuse the underlying typed array without copying; we'll copy when creating Buffer for SQLite
  const embeddings: Float32Array[] = [];
  const dimensions = tensor.dims[tensor.dims.length - 1];
  for (let i = 0; i < batchSize; i++) {
    const start = i * hiddenSize;
    embeddings.push(
      (tensor.data as Float32Array).subarray(start, start + hiddenSize),
    );
  }
  return { embeddings, dimensions };
}

export function huggingface(
  extractorFn: () =>
    | Promise<FeatureExtractionPipeline>
    | FeatureExtractionPipeline,
): Embedder {
  return (documents) => textEmbeddings(documents, { extractorFn });
}
