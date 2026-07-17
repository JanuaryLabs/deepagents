import type { FeatureExtractionPipeline } from '@huggingface/transformers';

import { tensorToEmbeddings } from './huggingface.js';
import type { Embedder } from '../stores/store.js';

/**
 * Stable model identifiers retained from the former `fastembed` adapter.
 */
export enum EmbeddingModel {
  AllMiniLML6V2 = 'fast-all-MiniLM-L6-v2',
  BGEBaseEN = 'fast-bge-base-en',
  BGEBaseENV15 = 'fast-bge-base-en-v1.5',
  BGESmallEN = 'fast-bge-small-en',
  BGESmallENV15 = 'fast-bge-small-en-v1.5',
  BGESmallZH = 'fast-bge-small-zh-v1.5',
  MLE5Large = 'fast-multilingual-e5-large',
}

const transformerModels: Record<EmbeddingModel, string> = {
  [EmbeddingModel.AllMiniLML6V2]: 'Xenova/all-MiniLM-L6-v2',
  [EmbeddingModel.BGEBaseEN]: 'Xenova/bge-base-en',
  [EmbeddingModel.BGEBaseENV15]: 'Xenova/bge-base-en-v1.5',
  [EmbeddingModel.BGESmallEN]: 'Xenova/bge-small-en',
  [EmbeddingModel.BGESmallENV15]: 'Xenova/bge-small-en-v1.5',
  [EmbeddingModel.BGESmallZH]: 'Xenova/bge-small-zh-v1.5',
  [EmbeddingModel.MLE5Large]: 'Xenova/multilingual-e5-large',
};

export interface FastEmbedOptions {
  model?: EmbeddingModel;
  batchSize?: number;
  cacheDir?: string;
}

/**
 * Local feature extraction backed by Transformers.js. The historical function
 * and model identifiers remain stable while avoiding FastEmbed's archived tar
 * extraction dependency.
 */
export function fastembed(options: FastEmbedOptions = {}): Embedder {
  const {
    model: modelId = EmbeddingModel.BGESmallENV15,
    batchSize = 256,
    cacheDir,
  } = options;

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError('batchSize must be a positive integer');
  }

  let modelPromise: Promise<FeatureExtractionPipeline> | null = null;
  const getModel = () => {
    if (!modelPromise) {
      modelPromise = import('@huggingface/transformers').then(({ pipeline }) =>
        pipeline('feature-extraction', transformerModels[modelId], {
          cache_dir: cacheDir,
        }),
      );
    }
    return modelPromise;
  };

  return async (documents: string[]) => {
    if (documents.length === 0) {
      return { embeddings: [], dimensions: 0 };
    }

    const model = await getModel();
    const embeddings: Float32Array[] = [];
    let dimensions = 0;

    for (let start = 0; start < documents.length; start += batchSize) {
      const tensor = await model(documents.slice(start, start + batchSize), {
        pooling: 'mean',
        normalize: true,
      });
      const batch = tensorToEmbeddings(tensor);
      dimensions ||= batch.dimensions;
      embeddings.push(...batch.embeddings);
    }

    return { embeddings, dimensions };
  };
}
