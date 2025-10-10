import { EmbeddingModel, FlagEmbedding } from 'fastembed';

import type { Embedder } from '../stores/store.js';

type StandardModel =
  | EmbeddingModel.AllMiniLML6V2
  | EmbeddingModel.BGEBaseEN
  | EmbeddingModel.BGEBaseENV15
  | EmbeddingModel.BGESmallEN
  | EmbeddingModel.BGESmallENV15
  | EmbeddingModel.BGESmallZH
  | EmbeddingModel.MLE5Large;

export interface FastEmbedOptions {
  model?: StandardModel;
  batchSize?: number;
  cacheDir?: string;
}

export function fastembed(options: FastEmbedOptions = {}): Embedder {
  const {
    model: modelId = EmbeddingModel.BGESmallENV15,
    batchSize,
    cacheDir,
  } = options;

  let modelPromise: Promise<
    Awaited<ReturnType<typeof FlagEmbedding.init>>
  > | null = null;
  const getModel = () => {
    if (!modelPromise) {
      modelPromise = FlagEmbedding.init({
        model: modelId,
        cacheDir,
      });
    }
    return modelPromise;
  };

  return async (documents: string[]) => {
    const model = await getModel();
    const batches = model.embed(documents, batchSize);

    const embeddings: number[][] = [];
    let dimensions = 0;

    for await (const batch of batches) {
      for (const vec of batch) {
        if (dimensions === 0) dimensions = vec.length;
        embeddings.push(vec);
      }
    }

    return { embeddings, dimensions };
  };
}
