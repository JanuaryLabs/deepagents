import { Corpus } from 'tiny-tfidf';

import {
  type ReminderContext,
  type UserReminder,
  reminder,
} from '../fragments/message/user.ts';
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

function isSkillClassifier(value: unknown): value is ISkillClassifier {
  return (
    typeof value === 'object' &&
    value !== null &&
    'match' in value &&
    typeof (value as ISkillClassifier).match === 'function'
  );
}

function formatSkillReminder(matches: SkillMatch[]): string {
  const lines = matches.map(
    (m) =>
      `- ${m.skill.name} (${m.score.toFixed(2)}): ${m.skill.description} [${m.skill.skillMdPath}]`,
  );
  return `Relevant skills:\n${lines.join('\n')}`;
}

export function skillsReminder(
  skillsOrClassifier: SkillMetadata[] | ISkillClassifier,
  options?: SkillClassifierOptions,
): UserReminder {
  const classifier = isSkillClassifier(skillsOrClassifier)
    ? skillsOrClassifier
    : new BM25SkillClassifier(skillsOrClassifier);

  return reminder((ctx: ReminderContext) => {
    const matches = classifier.match(ctx.content, options);
    if (matches.length === 0) return '';
    return formatSkillReminder(matches);
  });
}
