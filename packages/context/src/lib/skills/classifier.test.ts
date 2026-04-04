import assert from 'node:assert';
import { describe, it } from 'node:test';

import { BM25SkillClassifier } from '@deepagents/context';
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

describe('BM25SkillClassifier', () => {
  it('returns relevant skills for a matching query', () => {
    const classifier = new BM25SkillClassifier(testSkills);
    const matches = classifier.match('deploy my docker container');

    assert.ok(matches.length > 0, 'Should return at least one match');

    const matchNames = matches.map((m) => m.skill.name);
    assert.ok(
      matchNames.includes('docker-expert') ||
        matchNames.includes('deploy-helper'),
      'Should match deployment or docker skills',
    );
  });

  it('returns scores in descending order', () => {
    const classifier = new BM25SkillClassifier(testSkills);
    const matches = classifier.match('deploy docker container to production');

    for (let i = 1; i < matches.length; i++) {
      assert.ok(
        matches[i - 1].score >= matches[i].score,
        `Score at index ${i - 1} (${matches[i - 1].score}) should be >= score at index ${i} (${matches[i].score})`,
      );
    }
  });

  it('respects topN limit', () => {
    const classifier = new BM25SkillClassifier(testSkills);
    const matches = classifier.match('help me with code', { topN: 3 });

    assert.ok(
      matches.length <= 3,
      `Expected at most 3 matches, got ${matches.length}`,
    );
  });

  it('filters by threshold', () => {
    const classifier = new BM25SkillClassifier(testSkills);
    const matches = classifier.match('deploy', { threshold: 0.5 });

    for (const match of matches) {
      assert.ok(
        match.score > 0.5,
        `Expected score > 0.5, got ${match.score} for ${match.skill.name}`,
      );
    }
  });

  it('returns empty array for unrelated query', () => {
    const classifier = new BM25SkillClassifier(testSkills);
    const matches = classifier.match('xyzzyplugh');

    assert.strictEqual(matches.length, 0);
  });

  it('returns empty array for empty query', () => {
    const classifier = new BM25SkillClassifier(testSkills);
    const matches = classifier.match('');

    assert.strictEqual(matches.length, 0);
  });

  it('defaults topN to 5', () => {
    const classifier = new BM25SkillClassifier(testSkills);
    const matches = classifier.match('help');

    assert.ok(
      matches.length <= 5,
      `Expected at most 5 matches, got ${matches.length}`,
    );
  });
});
