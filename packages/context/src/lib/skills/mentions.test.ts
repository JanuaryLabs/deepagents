import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type AvailableSkill,
  collectExplicitSkillMentions,
  extractToolMentions,
  skillInstructions,
} from '@deepagents/context';

function mentions(text: string) {
  const { names, paths, plainNames } = extractToolMentions(text);
  return {
    names: [...names].toSorted(),
    paths: [...paths].toSorted(),
    plainNames: [...plainNames].toSorted(),
  };
}

function skill(name: string, path = `skills/${name}/SKILL.md`): AvailableSkill {
  return { name, description: `${name} skill.`, path };
}

describe('extractToolMentions', () => {
  it('reads plain $name mentions and linked [$name](path) mentions', () => {
    assert.deepStrictEqual(mentions('use $alpha and [$beta](/tmp/beta)'), {
      names: ['alpha', 'beta'],
      paths: ['/tmp/beta'],
      plainNames: ['alpha'],
    });
  });

  it('drops the common environment variable names in any case', () => {
    assert.deepStrictEqual(
      mentions(
        'use $PATH $path $Home $USER $SHELL $PWD $TMPDIR $TEMP $TMP $LANG $TERM $xdg_config_home [$HOME](/tmp/skill) and $alpha',
      ),
      { names: ['alpha'], paths: [], plainNames: ['alpha'] },
    );
  });

  it('falls back to the plain name when the link has no path or no parentheses', () => {
    assert.deepStrictEqual(
      mentions('[beta](/tmp/beta) [$gamma]() [$delta] x'),
      {
        names: ['delta', 'gamma'],
        paths: [],
        plainNames: ['delta', 'gamma'],
      },
    );
  });

  it('trims a linked path and allows spacing before its parenthesis', () => {
    assert.deepStrictEqual(mentions('use [$beta]   ( /tmp/beta )'), {
      names: ['beta'],
      paths: ['/tmp/beta'],
      plainNames: [],
    });
  });

  it('ends a name at the first character outside [A-Za-z0-9_:-]', () => {
    assert.deepStrictEqual(
      mentions('use $alpha.skill, $beta_extra, $slack:search and $$ $'),
      {
        names: ['alpha', 'beta_extra', 'slack:search'],
        paths: [],
        plainNames: ['alpha', 'beta_extra', 'slack:search'],
      },
    );
  });

  it('reads a mention inside a code span like any other text', () => {
    assert.deepStrictEqual(mentions('run `$deploy` now'), {
      names: ['deploy'],
      paths: [],
      plainNames: ['deploy'],
    });
  });

  it('keeps the path of an app, mcp or plugin link but not its name', () => {
    assert.deepStrictEqual(
      mentions('[$a](app://a) [$m](mcp://m) [$p](plugin://p) [$s](skill://s)'),
      {
        names: ['s'],
        paths: ['app://a', 'mcp://m', 'plugin://p', 'skill://s'],
        plainNames: [],
      },
    );
  });
});

describe('collectExplicitSkillMentions', () => {
  const catalog = [skill('alpha'), skill('beta'), skill('gamma')];

  it('selects mentioned skills in catalog order, each once', () => {
    assert.deepStrictEqual(
      collectExplicitSkillMentions(
        ['$gamma then $alpha, $gamma again'],
        catalog,
      ),
      [skill('alpha'), skill('gamma')],
    );
  });

  it('ignores names no skill has and environment variable names', () => {
    const path = skill('PATH');
    assert.deepStrictEqual(
      collectExplicitSkillMentions(['$unknown $PATH'], [...catalog, path]),
      [],
    );
  });

  it('skips a plain name that more than one skill uses', () => {
    const twins = [skill('alpha', 'a/SKILL.md'), skill('alpha', 'b/SKILL.md')];
    assert.deepStrictEqual(
      collectExplicitSkillMentions(['$alpha $beta'], [...twins, skill('beta')]),
      [skill('beta')],
    );
  });

  it('selects a linked skill by its path, before plain names, whatever name the link shows', () => {
    const twins = [skill('alpha', 'a/SKILL.md'), skill('alpha', 'b/SKILL.md')];
    assert.deepStrictEqual(
      collectExplicitSkillMentions(
        ['$beta and [$other](b/SKILL.md) and [$x](skill://a/SKILL.md)'],
        [skill('beta'), ...twins],
      ),
      [twins[0], twins[1], skill('beta')],
    );
  });

  it('selects a linked skill once when its plain name is mentioned too', () => {
    assert.deepStrictEqual(
      collectExplicitSkillMentions(
        ['[$alpha](skills/alpha/SKILL.md) and $alpha'],
        catalog,
      ),
      [skill('alpha')],
    );
  });

  it('selects input by input, each in catalog order', () => {
    assert.deepStrictEqual(
      collectExplicitSkillMentions(['$gamma', '$alpha $gamma $beta'], catalog),
      [skill('gamma'), skill('alpha'), skill('beta')],
    );
  });
});

describe('skillInstructions', () => {
  it('wraps the whole SKILL.md in Codex’s <skill> block', () => {
    assert.strictEqual(
      skillInstructions({
        name: 'deploy',
        path: 'skills/deploy/SKILL.md',
        contents: '---\nname: deploy\ndescription: Ship.\n---\n\n# Deploy',
      }),
      '<skill>\n<name>deploy</name>\n<path>skills/deploy/SKILL.md</path>\n---\nname: deploy\ndescription: Ship.\n---\n\n# Deploy\n</skill>',
    );
  });
});
