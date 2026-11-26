import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type AvailableSkill,
  ContextEngine,
  InMemoryContextStore,
  MarkdownRenderer,
  TomlRenderer,
  ToonRenderer,
  XmlRenderer,
  parseFrontmatter,
  role,
  skills,
} from '@deepagents/context';

const catalog = [
  '<skills_instructions>',
  '## Skills',
  'A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem.',
  '### Available skills',
  '- deploy: Deploy services to production. (file: /skills/deploy/SKILL.md)',
  '- lint: (file: /skills/lint/SKILL.md)',
  '### How to use skills',
  '- Discovery: The list above is the skills available in this session (name + description + source locator). `file` entries live on the host filesystem.',
  "- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.",
  "- Missing/blocked: If a named skill isn't in the list or its source can't be read, say so briefly and continue with the best fallback.",
  '- How to use a skill (progressive disclosure):',
  '  1) After deciding to use a skill, the main agent must read its `SKILL.md` completely before taking task actions. For a `file` entry, open the listed path.',
  '  2) When `SKILL.md` references another resource, use the same access mechanism.',
  '  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify the resources required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.',
  '  4) For filesystem-backed skills, prefer running or patching provided scripts instead of retyping large code blocks.',
  '  5) Reuse provided assets or templates through the same source access mechanism instead of recreating them.',
  '- Coordination and sequencing:',
  "  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.",
  "  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.",
  '- Context hygiene:',
  '  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.',
  "  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.",
  '  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.',
  "- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.",
  '</skills_instructions>',
].join('\n');

function createContext(...availableSkills: AvailableSkill[]) {
  return new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'skills-test',
    userId: 'user',
  }).set(skills(availableSkills));
}

describe('skills()', () => {
  for (const [format, renderer] of [
    ['XML', new XmlRenderer()],
    ['Markdown', new MarkdownRenderer()],
    ['TOML', new TomlRenderer()],
    ['TOON', new ToonRenderer()],
  ] as const) {
    it(`renders Codex's skills catalog as written in ${format}`, async () => {
      const availableSkills: AvailableSkill[] = [
        {
          name: 'deploy',
          description: 'Deploy services to production.',
          path: '/skills/deploy/SKILL.md',
        },
        { name: 'lint', description: '', path: '/skills/lint/SKILL.md' },
      ];
      const context = createContext(...availableSkills);

      const { systemPrompt } = await context.resolve({ renderer });

      assert.strictEqual(systemPrompt, catalog);
      assert.deepStrictEqual(context.getAvailableSkills(), availableSkills);
    });
  }

  it('renders the catalog at the top level beside other fragments', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'skills-top-level-test',
      userId: 'user',
    }).set(
      role('R'),
      skills([
        {
          name: 'deploy',
          description: 'Deploy services to production.',
          path: '/skills/deploy/SKILL.md',
        },
        { name: 'lint', description: '', path: '/skills/lint/SKILL.md' },
      ]),
    );

    const { systemPrompt } = await context.resolve({
      renderer: new XmlRenderer(),
    });

    assert.strictEqual(systemPrompt, `<role>R</role>\n${catalog}`);
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
