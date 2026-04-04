import { Corpus } from 'tiny-tfidf';

import { type WhenPredicate } from '../fragments/message/user.ts';
import type { SkillMetadata } from './types.ts';

export interface SkillMatch {
  skill: SkillMetadata;
  score: number;
}

export interface SkillClassifierOptions {
  topN?: number;
  threshold?: number;
}

export interface ISkillClassifier {
  match(query: string, options?: SkillClassifierOptions): SkillMatch[];
}

export class BM25SkillClassifier implements ISkillClassifier {
  #corpus: Corpus;
  #skillsByName: Map<string, SkillMetadata>;

  constructor(skills: SkillMetadata[]) {
    const names = skills.map((s) => s.name);
    const texts = skills.map((s) => `${s.name} ${s.description}`);
    this.#corpus = new Corpus(names, texts);
    this.#skillsByName = new Map(skills.map((s) => [s.name, s]));
  }

  match(query: string, options?: SkillClassifierOptions): SkillMatch[] {
    const topN = options?.topN ?? 5;
    const threshold = options?.threshold ?? 0;

    const results = this.#corpus.getResultsForQuery(query);

    return results
      .filter(([, score]: [string, number]) => score > threshold)
      .slice(0, topN)
      .map(([name, score]: [string, number]) => ({
        skill: this.#skillsByName.get(name)!,
        score,
      }));
  }
}

export interface ContentMatchesOptions {
  threshold?: number;
}

export function contentMatches(
  topics: string[],
  options?: ContentMatchesOptions,
): WhenPredicate {
  const corpus = new Corpus(
    topics.map((_, i) => `t${i}`),
    topics,
  );
  const threshold = options?.threshold ?? 0;
  return (ctx) =>
    corpus
      .getResultsForQuery(ctx.content)
      .some(([, score]: [string, number]) => score > threshold);
}

export function classifies(
  classifier: ISkillClassifier,
  options?: SkillClassifierOptions,
): WhenPredicate {
  return (ctx) => classifier.match(ctx.content, options).length > 0;
}
