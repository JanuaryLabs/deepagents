import { Corpus } from 'tiny-tfidf';

import type {
  ClassifierMatch,
  ClassifierOptions,
  IClassifier,
} from '../types.ts';

export class BM25Classifier<
  T extends { name: string; description: string },
> implements IClassifier<T> {
  #corpus: Corpus;
  #itemsByName: Map<string, T>;

  constructor(items: T[]) {
    const names = items.map((item) => item.name);
    const texts = items.map((item) => `${item.name} ${item.description}`);
    this.#corpus = new Corpus(names, texts);
    this.#itemsByName = new Map(items.map((item) => [item.name, item]));
  }

  match(query: string, options?: ClassifierOptions): ClassifierMatch<T>[] {
    const topN = options?.topN ?? 5;
    const threshold = options?.threshold ?? 0;

    return this.#corpus
      .getResultsForQuery(query)
      .filter(([, score]: [string, number]) => score > threshold)
      .slice(0, topN)
      .map(([name, score]: [string, number]) => {
        const item = this.#itemsByName.get(name);
        if (!item) return null;
        return { item, score };
      })
      .filter((match): match is ClassifierMatch<T> => match !== null);
  }
}
