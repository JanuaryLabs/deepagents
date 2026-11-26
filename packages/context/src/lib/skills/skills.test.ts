import { describe, it } from '@zukhruf/parameterized-test';
import assert from 'node:assert';

import {
  type AvailableSkill,
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  MarkdownRenderer,
  TomlRenderer,
  ToonRenderer,
  XmlRenderer,
  parseFrontmatter,
  parseSkillFrontmatter,
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

const catalogHead = [
  '<skills_instructions>',
  '## Skills',
  'A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem.',
  '### Available skills',
].join('\n');

async function renderedSkillLines(fragment: ContextFragment) {
  const { systemPrompt } = await new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'skills-lines-test',
    userId: 'user',
  })
    .set(fragment)
    .resolve({ renderer: new XmlRenderer() });
  assert.ok(systemPrompt.startsWith(`${catalogHead}\n`));
  return systemPrompt
    .slice(catalogHead.length + 1)
    .split('\n### How to use skills\n')[0]
    .split('\n');
}

function availableSkillsOf(fragment: ContextFragment) {
  return new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'skills-metadata-test',
    userId: 'user',
  })
    .set(fragment)
    .getAvailableSkills();
}

function createContext(...availableSkills: AvailableSkill[]) {
  return new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: 'skills-test',
    userId: 'user',
  }).set(skills(availableSkills));
}

describe('skills()', () => {
  void it.each(
    [
      ['XML', XmlRenderer],
      ['Markdown', MarkdownRenderer],
      ['TOML', TomlRenderer],
      ['TOON', ToonRenderer],
    ] as const,
    ([format, Renderer]) =>
      it(`renders Codex's skills catalog as written in ${format}`, async () => {
        const renderer = new Renderer();
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
      }),
  );

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

describe('skills() limits', () => {
  it("cuts a description longer than 1024 characters to 1021 and '...', and keeps the full skill in the engine", async () => {
    const description = '0123456789'.repeat(200);
    const deploy = {
      name: 'deploy',
      description,
      path: '/skills/deploy/SKILL.md',
    };
    const fragment = skills([deploy]);

    assert.deepStrictEqual(await renderedSkillLines(fragment), [
      `- deploy: ${description.slice(0, 1021)}... (file: /skills/deploy/SKILL.md)`,
    ]);
    assert.deepStrictEqual(availableSkillsOf(fragment), [deploy]);
    assert.strictEqual(fragment.metadata.warning, undefined);
  });

  it('counts descriptions and lines in Unicode scalars, not UTF-16 code units', async () => {
    const description = '💡'.repeat(1024);
    const available = Array.from({ length: 4 }, (_, index) => ({
      name: `i${index}`,
      description,
      path: `/i/i${index}/SKILL.md`,
    }));

    // Each line is 1053 scalars (2077 code units): four fit in 8000.
    assert.deepStrictEqual(
      await renderedSkillLines(skills(available)),
      available.map(
        ({ name, path }) => `- ${name}: ${description} (file: ${path})`,
      ),
    );
  });

  it('gives what a short description leaves to the others, the remainder to the first in order', async () => {
    const long = '0123456789'.repeat(100);
    const available = Array.from({ length: 10 }, (_, index) => ({
      name: `s${index}`,
      description: index === 0 ? 'abcdefg' : long,
      path: `/s/s${index}/SKILL.md`,
    }));

    // 7710 after the bare lines: s0 takes 8 for its 7 characters, and the
    // 7702 left give s1-s9 854 characters each with 7 to spare for s1-s7.
    assert.deepStrictEqual(await renderedSkillLines(skills(available)), [
      '- s0: abcdefg (file: /s/s0/SKILL.md)',
      ...available
        .slice(1)
        .map(
          ({ name, path }, index) =>
            `- ${name}: ${long.slice(0, index < 7 ? 855 : 854)} (file: ${path})`,
        ),
    ]);
  });

  it('still lists later skills that fit after one that does not', async () => {
    const fragment = skills([
      { name: 'a', description: 'A.', path: '/a' },
      { name: 'b', description: 'B.', path: `/${'p'.repeat(7979)}` },
      { name: 'c', description: 'C.', path: '/c' },
      { name: 'd', description: 'D.', path: '/d' },
    ]);

    assert.deepStrictEqual(await renderedSkillLines(fragment), [
      '- a: (file: /a)',
      '- c: (file: /c)',
      '- d: (file: /d)',
    ]);
    assert.strictEqual(
      fragment.metadata.warning,
      'Exceeded skills context budget. All skill descriptions were removed and 1 additional skill was not included in the model-visible skills list.',
    );
  });

  it('shares the 8000-character budget round-robin over descriptions when every bare line fits', async () => {
    const description = '0123456789'.repeat(100);
    const available = Array.from({ length: 10 }, (_, index) => ({
      name: `s${index}`,
      description,
      path: `/s/s${index}/SKILL.md`,
    }));
    const fragment = skills(available);

    // A bare line costs 29 (28 characters and its newline), 290 for ten; the
    // 7710 left give each skill 770 characters and the space before them.
    assert.deepStrictEqual(
      await renderedSkillLines(fragment),
      available.map(
        ({ name, path }) =>
          `- ${name}: ${description.slice(0, 770)} (file: ${path})`,
      ),
    );
    assert.strictEqual(fragment.metadata.warning, undefined);
  });

  it("drops every description and the skills past the budget with Codex's warning", async () => {
    const available = Array.from({ length: 300 }, (_, index) => {
      const name = `s${String(index).padStart(3, '0')}`;
      return { name, description: 'Unused.', path: `/s/${name}/SKILL.md` };
    });
    const fragment = skills(available.toReversed());

    // A bare line costs 33, so 242 lines fit in 8000 characters.
    assert.deepStrictEqual(
      await renderedSkillLines(fragment),
      available
        .slice(0, 242)
        .map(({ name, path }) => `- ${name}: (file: ${path})`),
    );
    assert.strictEqual(
      fragment.metadata.warning,
      'Exceeded skills context budget. All skill descriptions were removed and 58 additional skills were not included in the model-visible skills list.',
    );
    assert.deepStrictEqual(availableSkillsOf(fragment), available.toReversed());
  });

  it('names one omitted skill in the singular', () => {
    const available = Array.from({ length: 243 }, (_, index) => {
      const name = `s${String(index).padStart(3, '0')}`;
      return { name, description: 'Unused.', path: `/s/${name}/SKILL.md` };
    });

    assert.strictEqual(
      skills(available).metadata.warning,
      'Exceeded skills context budget. All skill descriptions were removed and 1 additional skill was not included in the model-visible skills list.',
    );
  });

  it('orders skills by name, then path, in code-unit order', async () => {
    assert.deepStrictEqual(
      await renderedSkillLines(
        skills([
          { name: 'alpha', description: 'A2.', path: '/b/SKILL.md' },
          { name: 'alpha', description: 'A1.', path: '/a/SKILL.md' },
          { name: 'Zeta', description: 'Z.', path: '/z/SKILL.md' },
        ]),
      ),
      [
        '- Zeta: Z. (file: /z/SKILL.md)',
        '- alpha: A1. (file: /a/SKILL.md)',
        '- alpha: A2. (file: /b/SKILL.md)',
      ],
    );
  });
});

describe('parseSkillFrontmatter()', () => {
  it('collapses the name and description to one line and defaults a missing name', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        '---\ndescription: |\n  Deploy services\n  to   production.\n---\n\n# Deploy\n',
        'deploy-dir',
      ),
      { name: 'deploy-dir', description: 'Deploy services to production.' },
    );
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        '---\nname: "  weekly   report "\ndescription: Report.\n---\n',
        'reports',
      ),
      { name: 'weekly report', description: 'Report.' },
    );
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        '---\r\nname: "   "\r\ndescription: CRLF.\r\n---\r\n',
        'crlf-dir',
      ),
      { name: 'crlf-dir', description: 'CRLF.' },
    );
  });

  it('accepts a 64-character name', () => {
    const name = 'n'.repeat(64);
    assert.deepStrictEqual(
      parseSkillFrontmatter(`---\nname: ${name}\ndescription: D.\n---\n`, 'x'),
      { name, description: 'D.' },
    );
  });

  it("rejects a skill with Codex's error texts", () => {
    assert.throws(
      () =>
        parseSkillFrontmatter(
          `---\nname: ${'n'.repeat(65)}\ndescription: D.\n---\n`,
          'x',
        ),
      { message: 'invalid name: exceeds maximum length of 64 characters' },
    );
    assert.throws(
      () => parseSkillFrontmatter('---\nname: lint\n---\n', 'lint'),
      { message: 'missing field `description`' },
    );
    assert.throws(
      () =>
        parseSkillFrontmatter(
          '---\nname: lint\ndescription: "  "\n---\n',
          'lint',
        ),
      { message: 'missing field `description`' },
    );
    assert.throws(() => parseSkillFrontmatter('# No frontmatter', 'lint'), {
      message: 'missing YAML frontmatter delimited by ---',
    });
    assert.throws(
      () => parseSkillFrontmatter('---\nname: lint\ndescription: D.\n', 'lint'),
      { message: 'missing YAML frontmatter delimited by ---' },
    );
    assert.throws(
      () =>
        parseSkillFrontmatter(
          '---\nname: lint\ndescription: "Build for AWS: ECS\n---\n',
          'lint',
        ),
      { message: /^invalid YAML: / },
    );
    assert.throws(
      () =>
        parseSkillFrontmatter('---\nname: 123\ndescription: D.\n---\n', 'x'),
      { message: /^invalid YAML: / },
    );
    assert.throws(() => parseSkillFrontmatter('---\njust text\n---\n', 'x'), {
      message: /^invalid YAML: /,
    });
  });

  it('repairs and sanitizes an unquoted description containing a colon', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        '---\nname:  deploy  service\ndescription: Build for AWS: ECS\nmetadata:\n  short-description:  Deploy   safely\n---\n',
        'fallback',
      ),
      { name: 'deploy service', description: 'Build for AWS: ECS' },
    );
  });

  it('uses the default name and requires a description', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter('---\ndescription: Demo skill\n---\n', 'demo'),
      { name: 'demo', description: 'Demo skill' },
    );
    assert.throws(
      () => parseSkillFrontmatter('---\nname: demo\n---\n', 'fallback'),
      { message: 'missing field `description`' },
    );
  });

  it('repairs a nested value containing a colon and an apostrophe', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        "---\nname: short\ndescription: Short skill\nmetadata:\n  short-description: What's included: builds and tests\n---\n",
        'fallback',
      ),
      { name: 'short', description: 'Short skill' },
    );
  });

  it('repairs unrecognized fields that need quotes', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        '---\nname: unknown\ndescription: Unknown fields\nargument-hint: <duration: e.g. 7d, 2w>\ntags: [next,@supabase/ssr]\n---\n',
        'fallback',
      ),
      { name: 'unknown', description: 'Unknown fields' },
    );
  });

  it('preserves block scalar bodies while repairing other fields', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        '---\nname: block\ndescription: |-\n  Build for AWS: ECS\nargument-hint: <duration: e.g. 7d>\n---\n',
        'fallback',
      ),
      { name: 'block', description: 'Build for AWS: ECS' },
    );
  });

  it('leaves a block scalar body line that looks repairable as written', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        '---\nname: block\ndescription: |-\n  Build for AWS: ECS: Fargate\nargument-hint: <duration: e.g. 7d>\n---\n',
        'fallback',
      ),
      { name: 'block', description: 'Build for AWS: ECS: Fargate' },
    );
  });

  it('keeps an overlong description whole', () => {
    const description = '💡'.repeat(1025);
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        `---\nname: long\ndescription: ${description}\nmetadata:\n  short-description: ${'x'.repeat(1025)}\n---\n`,
        'fallback',
      ),
      { name: 'long', description },
    );
  });

  it('quotes a repaired value, escaping apostrophes and keeping a trailing comment out', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter(
        "---\nname: it's: odd # a comment\ndescription: Ops: deploy\n---\n",
        'fallback',
      ),
      { name: "it's: odd", description: 'Ops: deploy' },
    );
  });

  it('repairs a value whose type is wrong when it holds a colon separator', () => {
    assert.deepStrictEqual(
      parseSkillFrontmatter('---\nname: x\ndescription: {a: b}\n---\n', 'x'),
      { name: 'x', description: '{a: b}' },
    );
  });

  it('repairs an invalid flow-like value, then reports what the repaired YAML lacks', () => {
    assert.throws(
      () => parseSkillFrontmatter('---\nname: [lint\n---\n', 'lint'),
      { message: 'missing field `description`' },
    );
  });

  it('reports the original YAML error when the repaired YAML is still invalid', () => {
    assert.throws(
      () =>
        parseSkillFrontmatter(
          '---\nname: x\ndescription: Build for AWS: ECS\n  bad: [\n---\n',
          'x',
        ),
      {
        message:
          /^invalid YAML: Nested mappings are not allowed in compact mappings at line 2/,
      },
    );
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
