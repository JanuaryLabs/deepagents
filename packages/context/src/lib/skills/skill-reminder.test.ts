import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ClassifierMatch,
  type ClassifierOptions,
  ContextEngine,
  type IClassifier,
  InMemoryContextStore,
  reminder,
  skillsReminder,
  user,
} from '@deepagents/context';
import type { SkillMetadata } from '@deepagents/context';

function makeSkill(name: string, description: string): SkillMetadata {
  return {
    name,
    description,
    path: `/skills/${name}`,
    skillMdPath: `/skills/${name}/SKILL.md`,
  };
}

const testSkills: SkillMetadata[] = [
  makeSkill(
    'deploy-helper',
    'Assists with deployment workflows and CI/CD pipelines',
  ),
  makeSkill('docker-expert', 'Docker containerization and multi-stage builds'),
  makeSkill('api-route', 'Create or extend Hono backend API routes'),
  makeSkill(
    'react-email',
    'Creating HTML email templates with React components',
  ),
  makeSkill(
    'sql-optimization',
    'SQL query optimization and indexing strategies',
  ),
  makeSkill('seo-audit', 'Audit and diagnose SEO issues on websites'),
  makeSkill('pricing-strategy', 'Help with pricing decisions and monetization'),
  makeSkill('commit', 'Write conventional commit messages'),
  makeSkill('brainstorming', 'Help turn ideas into designs through dialogue'),
  makeSkill('code-review', 'Review code for bugs and quality issues'),
];

/**
 * Declare user-target reminders (including skillsReminder) on the engine and
 * return the persisted user message after the save fold bakes them in.
 */
async function bakeUserMessage(
  content: string | (UIMessage & { role: 'user' }),
  ...reminders: ReturnType<typeof reminder>[]
): Promise<UIMessage> {
  const store = new InMemoryContextStore();
  const engine = new ContextEngine({ store, chatId: 'skills', userId: 'u' });
  engine.set(...reminders, user(content));
  await engine.save();
  const users = (await store.getMessages('skills')).filter(
    (m) => m.name === 'user',
  );
  return users[users.length - 1].data as UIMessage;
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

describe('skillsReminder', () => {
  it('creates a factory reminder that resolves with skill matches', async () => {
    const message = await bakeUserMessage(
      'deploy my app to production',
      skillsReminder(testSkills, { topN: 3 }),
    );
    const textParts = textOf(message);

    assert.ok(
      textParts.includes('Relevant skills:'),
      'Should contain skills reminder header',
    );
    assert.ok(
      textParts.includes('SKILL.md'),
      'Should contain skill file paths',
    );
  });

  it('includes scores and paths in the formatted output', async () => {
    const message = await bakeUserMessage(
      'optimize my SQL queries',
      skillsReminder(testSkills, { topN: 2 }),
    );
    const textParts = textOf(message);

    const reminderMatch = textParts.match(
      /<system-reminder>([\s\S]*?)<\/system-reminder>/,
    );
    assert.ok(reminderMatch, 'Should contain system-reminder tags');

    const reminderContent = reminderMatch![1];
    assert.ok(reminderContent.includes('Relevant skills:'));
    assert.match(
      reminderContent,
      /\(\d+\.\d+\)/,
      'Should contain score in parentheses',
    );
    assert.ok(reminderContent.includes('['), 'Should contain path brackets');
  });

  it('skips injection when no skills match', async () => {
    const message = await bakeUserMessage(
      'xyzzyplugh zorkbleep',
      skillsReminder(testSkills, { topN: 3 }),
    );
    const textParts = textOf(message);

    assert.ok(
      !textParts.includes('Relevant skills:'),
      'Should not contain skills reminder for unrelated query',
    );
    assert.strictEqual(
      textParts,
      'xyzzyplugh zorkbleep',
      'Message should be unchanged',
    );
  });

  it('accepts a custom classifier implementing IClassifier', async () => {
    const customClassifier: IClassifier<SkillMetadata> = {
      match(
        _query: string,
        _options?: ClassifierOptions,
      ): ClassifierMatch<SkillMetadata>[] {
        return [
          {
            item: makeSkill('custom-skill', 'A custom matched skill'),
            score: 0.99,
          },
        ];
      },
    };

    const message = await bakeUserMessage(
      'anything',
      skillsReminder(customClassifier, { topN: 5 }),
    );
    const textParts = textOf(message);

    assert.ok(
      textParts.includes('custom-skill'),
      'Should use custom classifier results',
    );
    assert.ok(textParts.includes('0.99'), 'Should include custom score');
  });
});

describe('factory reminders folded into the user message', () => {
  it('resolves factory reminders with message content', async () => {
    const factory = (ctx: { content: string }) => `Echo: ${ctx.content}`;
    const message = await bakeUserMessage('hello world', reminder(factory));
    const text = textOf(message);

    assert.ok(
      text.includes('<system-reminder>Echo: hello world</system-reminder>'),
      `Expected factory reminder to be resolved. Got: ${text}`,
    );
  });

  it('skips factory reminders that return empty string', async () => {
    const message = await bakeUserMessage(
      'hello',
      reminder(() => ''),
    );

    assert.strictEqual(message.parts.length, 1);
    assert.strictEqual(textOf(message), 'hello');
    assert.strictEqual(message.metadata, undefined);
  });

  it('mixes static and factory reminders', async () => {
    const message = await bakeUserMessage(
      'test',
      reminder('static hint'),
      reminder((ctx) => `dynamic: ${ctx.content}`),
      reminder(() => ''),
    );
    const text = textOf(message);

    assert.ok(text.includes('static hint'), 'Should contain static reminder');
    assert.ok(
      text.includes('dynamic: test'),
      'Should contain resolved factory reminder',
    );

    const metadata = message.metadata as { reminders?: unknown[] } | undefined;
    assert.strictEqual(
      metadata?.reminders?.length,
      2,
      'Should only have 2 reminders (empty skipped)',
    );
  });

  it('extracts text from UIMessage content for factory', async () => {
    const message = await bakeUserMessage(
      {
        id: 'multi-part',
        role: 'user',
        parts: [
          { type: 'text', text: 'first part' },
          { type: 'text', text: 'second part' },
        ],
      },
      reminder((ctx) => `Got: ${ctx.content}`),
    );
    const allText = textOf(message);

    assert.ok(
      allText.includes('Got: first part second part'),
      `Expected factory to receive joined text parts. Got: ${allText}`,
    );
  });
});
