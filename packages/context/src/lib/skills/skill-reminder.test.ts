import type { UIMessage } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ISkillClassifier,
  type SkillClassifierOptions,
  type SkillMatch,
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

function decodeMessage(fragment: ReturnType<typeof user>): UIMessage {
  const message = fragment.codec?.encode();
  assert.ok(message);
  return message as UIMessage;
}

describe('skillsReminder', () => {
  it('creates a factory reminder that resolves with skill matches', () => {
    const fragment = user(
      'deploy my app to production',
      skillsReminder(testSkills, { topN: 3 }),
    );
    const message = decodeMessage(fragment);
    const textParts = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

    assert.ok(
      textParts.includes('Relevant skills:'),
      'Should contain skills reminder header',
    );
    assert.ok(
      textParts.includes('SKILL.md'),
      'Should contain skill file paths',
    );
  });

  it('includes scores and paths in the formatted output', () => {
    const fragment = user(
      'optimize my SQL queries',
      skillsReminder(testSkills, { topN: 2 }),
    );
    const message = decodeMessage(fragment);
    const textParts = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

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

  it('skips injection when no skills match', () => {
    const fragment = user(
      'xyzzyplugh zorkbleep',
      skillsReminder(testSkills, { topN: 3 }),
    );
    const message = decodeMessage(fragment);
    const textParts = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

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

  it('accepts a custom classifier implementing ISkillClassifier', () => {
    const customClassifier: ISkillClassifier = {
      match(_query: string, _options?: SkillClassifierOptions): SkillMatch[] {
        return [
          {
            skill: makeSkill('custom-skill', 'A custom matched skill'),
            score: 0.99,
          },
        ];
      },
    };

    const fragment = user(
      'anything',
      skillsReminder(customClassifier, { topN: 5 }),
    );
    const message = decodeMessage(fragment);
    const textParts = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

    assert.ok(
      textParts.includes('custom-skill'),
      'Should use custom classifier results',
    );
    assert.ok(textParts.includes('0.99'), 'Should include custom score');
  });
});

describe('factory reminders in user()', () => {
  it('resolves factory reminders with message content', () => {
    const factory = (ctx: { content: string }) => `Echo: ${ctx.content}`;
    const fragment = user('hello world', reminder(factory));
    const message = decodeMessage(fragment);
    const text = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

    assert.ok(
      text.includes('<system-reminder>Echo: hello world</system-reminder>'),
      `Expected factory reminder to be resolved. Got: ${text}`,
    );
  });

  it('skips factory reminders that return empty string', () => {
    const fragment = user(
      'hello',
      reminder(() => ''),
    );
    const message = decodeMessage(fragment);

    assert.strictEqual(message.parts.length, 1);
    const text = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    assert.strictEqual(text, 'hello');
    assert.strictEqual(message.metadata, undefined);
  });

  it('mixes static and factory reminders', () => {
    const fragment = user(
      'test',
      reminder('static hint'),
      reminder((ctx) => `dynamic: ${ctx.content}`),
      reminder(() => ''),
    );
    const message = decodeMessage(fragment);
    const text = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

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

  it('extracts text from UIMessage content for factory', () => {
    const fragment = user(
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
    const message = decodeMessage(fragment);
    const allText = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');

    assert.ok(
      allText.includes('Got: first part second part'),
      `Expected factory to receive joined text parts. Got: ${allText}`,
    );
  });
});
