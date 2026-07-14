import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type AvailableSkill,
  ContextEngine,
  InMemoryContextStore,
  XmlRenderer,
  parseFrontmatter,
  skills,
} from '@deepagents/context';

function createContext(...availableSkills: AvailableSkill[]) {
  return new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'skills-test',
    userId: 'user',
  }).set(skills(availableSkills));
}

describe('skills()', () => {
  it('renders caller-supplied metadata through the public context flow', async () => {
    const availableSkills: AvailableSkill[] = [
      {
        name: 'deploy',
        description: 'Deploy services to production.',
        path: '/skills/deploy/SKILL.md',
      },
      {
        name: 'data-analysis',
        description: 'Analyze datasets and summarize findings.',
        path: '/mnt/gcs/skills/data-analysis/SKILL.md',
      },
    ];
    const context = createContext(...availableSkills);

    const { systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
    });

    assert.match(systemPrompt, /<available_skills>/);
    assert.match(systemPrompt, /<name>deploy<\/name>/);
    assert.match(
      systemPrompt,
      /<description>Deploy services to production\.<\/description>/,
    );
    assert.match(systemPrompt, /<path>\/skills\/deploy\/SKILL\.md<\/path>/);
    assert.match(
      systemPrompt,
      /<path>\/mnt\/gcs\/skills\/data-analysis\/SKILL\.md<\/path>/,
    );
    assert.deepStrictEqual(context.getAvailableSkills(), availableSkills);
  });

  it('keeps the rendered catalog and engine metadata consistent when the caller mutates its input', async () => {
    const availableSkills: AvailableSkill[] = [
      {
        name: 'deploy',
        description: 'Deploy services to production.',
        path: '/skills/deploy/SKILL.md',
      },
    ];
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'skills-input-snapshot-test',
      userId: 'user',
    }).set(skills(availableSkills));

    availableSkills[0].description = 'Mutated after fragment construction.';
    availableSkills[0].path = '/mutated/SKILL.md';
    availableSkills.push({
      name: 'late-addition',
      description: 'Added after fragment construction.',
      path: '/skills/late-addition/SKILL.md',
    });

    const { systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
    });

    assert.match(systemPrompt, /Deploy services to production\./);
    assert.match(systemPrompt, /\/skills\/deploy\/SKILL\.md/);
    assert.doesNotMatch(systemPrompt, /Mutated after fragment construction/);
    assert.doesNotMatch(systemPrompt, /late-addition/);
    assert.deepStrictEqual(context.getAvailableSkills(), [
      {
        name: 'deploy',
        description: 'Deploy services to production.',
        path: '/skills/deploy/SKILL.md',
      },
    ]);
  });

  it('returns defensive skill catalog copies from the engine', () => {
    const context = createContext({
      name: 'deploy',
      description: 'Deploy services to production.',
      path: '/skills/deploy/SKILL.md',
    });

    const firstRead = context.getAvailableSkills();
    firstRead[0].description = 'Mutated through the getter.';
    firstRead[0].path = '/mutated/SKILL.md';
    firstRead.push({
      name: 'late-addition',
      description: 'Added through the getter.',
      path: '/skills/late-addition/SKILL.md',
    });

    assert.deepStrictEqual(context.getAvailableSkills(), [
      {
        name: 'deploy',
        description: 'Deploy services to production.',
        path: '/skills/deploy/SKILL.md',
      },
    ]);
  });

  it('does not infer skills when the caller supplies none', async () => {
    const context = createContext();

    const { systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
    });

    assert.deepStrictEqual(context.getAvailableSkills(), []);
    assert.doesNotMatch(systemPrompt, /SKILL\.md/);
  });
});

describe('parseFrontmatter()', () => {
  it('parses required and additional frontmatter without reading a host path', () => {
    const result = parseFrontmatter(`---
name: deploy
description: Deploy services safely
version: 1.0.0
---

# Deploy

Run the deployment workflow.`);

    assert.deepStrictEqual(result.frontmatter, {
      name: 'deploy',
      description: 'Deploy services safely',
      version: '1.0.0',
    });
    assert.strictEqual(result.body, '# Deploy\n\nRun the deployment workflow.');
  });

  it('rejects missing or incomplete frontmatter', () => {
    assert.throws(
      () => parseFrontmatter('# No frontmatter'),
      /missing or malformed frontmatter/i,
    );
    assert.throws(
      () => parseFrontmatter('---\ndescription: Missing name\n---\n'),
      /must have a "name" field/i,
    );
    assert.throws(
      () => parseFrontmatter('---\nname: missing-description\n---\n'),
      /must have a "description" field/i,
    );
  });
});
