import type { ContextFragment } from '../fragments.ts';
import {
  BM25Classifier,
  type ClassifierMatch,
  type ClassifierOptions,
  type IClassifier,
  type ReminderContext,
  reminder,
} from '../fragments/reminders/index.ts';
import type { AvailableSkill } from './types.ts';

function formatSkillReminder(
  matches: ClassifierMatch<AvailableSkill>[],
): string {
  const lines = matches.map(
    (m) =>
      `- ${m.item.name} (${m.score.toFixed(2)}): ${m.item.description} [${m.item.path}]`,
  );
  return `Relevant skills:\n${lines.join('\n')}`;
}

export function skillsReminder(
  skillsOrClassifier: AvailableSkill[] | IClassifier<AvailableSkill>,
  options?: ClassifierOptions,
): ContextFragment {
  const classifier = Array.isArray(skillsOrClassifier)
    ? new BM25Classifier(skillsOrClassifier)
    : skillsOrClassifier;

  return reminder(
    (ctx: ReminderContext) => {
      const matches = classifier.match(ctx.content, options);
      if (matches.length === 0) return '';
      return formatSkillReminder(matches);
    },
    { target: 'user' },
  );
}
