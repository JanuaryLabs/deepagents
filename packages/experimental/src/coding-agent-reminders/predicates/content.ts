import { contentText } from '../context.ts';
import type {
  ClassifierOptions,
  ContentMatchesOptions,
  HookPredicate,
  IClassifier,
} from '../types.ts';
import { BM25Classifier } from './classifier.ts';

export function contentMatches(
  topics: string[],
  options?: ContentMatchesOptions,
): HookPredicate {
  const classifier = new BM25Classifier(
    topics.map((topic, index) => ({
      name: `t${index}`,
      description: topic,
    })),
  );
  return (ctx) =>
    classifier.match(contentText(ctx), {
      threshold: options?.threshold,
    }).length > 0;
}

export function classifies<T>(
  classifier: IClassifier<T>,
  options?: ClassifierOptions,
): HookPredicate {
  return (ctx) => classifier.match(contentText(ctx), options).length > 0;
}

export function contentIncludes(keywords: string[]): HookPredicate {
  const lower = keywords.map((keyword) => keyword.toLowerCase());
  return (ctx) => {
    const text = contentText(ctx).toLowerCase();
    return lower.some((keyword) => text.includes(keyword));
  };
}

export const contentPattern =
  (pattern: RegExp): HookPredicate =>
  (ctx) => {
    pattern.lastIndex = 0;
    return pattern.test(contentText(ctx));
  };

export const promptMatches = contentPattern;
