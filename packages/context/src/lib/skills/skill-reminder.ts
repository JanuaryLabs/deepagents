import {
  type ReminderContext,
  type UserReminder,
  reminder,
} from '../fragments/message/user.ts';
import {
  BM25SkillClassifier,
  type ISkillClassifier,
  type SkillClassifierOptions,
  type SkillMatch,
} from './classifier.ts';
import type { SkillMetadata } from './types.ts';

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
