import { type WhenPredicate } from '../message/user.ts';
import {
  BM25Classifier,
  type ClassifierOptions,
  type IClassifier,
} from './classifier.ts';

export interface ContentMatchesOptions {
  threshold?: number;
}

export function contentMatches(
  topics: string[],
  options?: ContentMatchesOptions,
): WhenPredicate {
  const classifier = new BM25Classifier(
    topics.map((t, i) => ({ name: `t${i}`, description: t })),
  );
  return (ctx) =>
    classifier.match(ctx.content, { threshold: options?.threshold }).length > 0;
}

export function classifies<T>(
  classifier: IClassifier<T>,
  options?: ClassifierOptions,
): WhenPredicate {
  return (ctx) => classifier.match(ctx.content, options).length > 0;
}
