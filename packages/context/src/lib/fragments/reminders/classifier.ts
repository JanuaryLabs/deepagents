import { Corpus } from 'tiny-tfidf';

export interface ClassifierMatch<T> {
  item: T;
  score: number;
}

export interface ClassifierOptions {
  topN?: number;
  threshold?: number;
}

export interface IClassifier<T> {
  match(query: string, options?: ClassifierOptions): ClassifierMatch<T>[];
}

export class BM25Classifier<
  T extends { name: string; description: string },
> implements IClassifier<T> {
  #corpus: Corpus;
  #itemsByName: Map<string, T>;

  constructor(items: T[]) {
    const names = items.map((s) => s.name);
    const texts = items.map((s) => `${s.name} ${s.description}`);
    this.#corpus = new Corpus(names, texts);
    this.#itemsByName = new Map(items.map((s) => [s.name, s]));
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
      .filter((m): m is ClassifierMatch<T> => m !== null);
  }
}
