import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  type ContextFragment,
  discoverSkillsInDirectory,
  loadSkillMetadata,
  parseFrontmatter,
  skills,
} from '@deepagents/context';

/**
 * Integration tests for the Skills Fragment module.
 *
 * Tests cover:
 * - SKILL.md frontmatter parsing
 * - Skill metadata loading from filesystem
 * - Skill discovery in directories
 * - skills() fragment creation with path remapping
 * - Include/exclude filtering
 */
describe('Skills Fragment', () => {
  let testDir: string;

  before(() => {
    // Create a temporary directory structure for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  });

  after(() => {
    // Cleanup temporary directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('parseFrontmatter()', () => {
    it('parses valid SKILL.md frontmatter', () => {
      const content = `---
name: test-skill
description: A test skill for unit testing
version: 1.0.0
---

# Test Skill

This is the body of the skill.`;

      const result = parseFrontmatter(content);

      assert.strictEqual(result.frontmatter.name, 'test-skill');
      assert.strictEqual(
        result.frontmatter.description,
        'A test skill for unit testing',
      );
      assert.strictEqual(result.frontmatter.version, '1.0.0');
      assert.strictEqual(
        result.body,
        '# Test Skill\n\nThis is the body of the skill.',
      );
    });

    it('parses frontmatter with multiline description', () => {
      const content = `---
name: multiline-skill
description: >
  This is a long description
  that spans multiple lines
---

Body content here.`;

      const result = parseFrontmatter(content);

      assert.strictEqual(result.frontmatter.name, 'multiline-skill');
      assert.ok(result.frontmatter.description.includes('long description'));
    });

    it('throws on missing frontmatter', () => {
      const content = `# No Frontmatter

Just body content.`;

      assert.throws(
        () => parseFrontmatter(content),
        /missing or malformed frontmatter/i,
      );
    });

    it('throws on missing name field', () => {
      const content = `---
description: Has description but no name
---

Body`;

      assert.throws(
        () => parseFrontmatter(content),
        /must have a "name" field/i,
      );
    });

    it('throws on missing description field', () => {
      const content = `---
name: no-description
---

Body`;

      assert.throws(
        () => parseFrontmatter(content),
        /must have a "description" field/i,
      );
    });

    it('handles empty body after frontmatter', () => {
      const content = `---
name: empty-body
description: Skill with empty body
---
`;

      const result = parseFrontmatter(content);

      assert.strictEqual(result.frontmatter.name, 'empty-body');
      assert.strictEqual(result.body, '');
    });

    it('preserves additional frontmatter fields', () => {
      const content = `---
name: extra-fields
description: Skill with extra metadata
author: Test Author
tags:
  - testing
  - example
---

Body`;

      const result = parseFrontmatter(content);

      assert.strictEqual(result.frontmatter.author, 'Test Author');
      assert.deepStrictEqual(result.frontmatter.tags, ['testing', 'example']);
    });
  });

  describe('loadSkillMetadata()', () => {
    it('loads skill metadata from SKILL.md file', () => {
      // Create a test skill directory
      const skillDir = path.join(testDir, 'load-test-skill');
      fs.mkdirSync(skillDir, { recursive: true });

      const skillMdPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(
        skillMdPath,
        `---
name: load-test
description: Skill for load testing
---

# Load Test Skill`,
      );

      const metadata = loadSkillMetadata(skillMdPath);

      assert.strictEqual(metadata.name, 'load-test');
      assert.strictEqual(metadata.description, 'Skill for load testing');
      assert.strictEqual(metadata.path, skillDir);
      assert.strictEqual(metadata.skillMdPath, skillMdPath);
    });

    it('returns correct path for nested skill directories', () => {
      // Create a deeply nested skill
      const nestedDir = path.join(testDir, 'nested', 'deeply', 'skill-folder');
      fs.mkdirSync(nestedDir, { recursive: true });

      const skillMdPath = path.join(nestedDir, 'SKILL.md');
      fs.writeFileSync(
        skillMdPath,
        `---
name: nested-skill
description: Deeply nested skill
---

Body`,
      );

      const metadata = loadSkillMetadata(skillMdPath);

      assert.strictEqual(metadata.path, nestedDir);
      assert.ok(metadata.skillMdPath.endsWith('SKILL.md'));
    });
  });

  describe('discoverSkillsInDirectory()', () => {
    let discoveryDir: string;

    before(() => {
      // Create a directory with multiple skills for discovery testing
      discoveryDir = path.join(testDir, 'discovery');
      fs.mkdirSync(discoveryDir, { recursive: true });

      // Create skill-a
      const skillA = path.join(discoveryDir, 'skill-a');
      fs.mkdirSync(skillA);
      fs.writeFileSync(
        path.join(skillA, 'SKILL.md'),
        `---
name: skill-a
description: First skill
---

# Skill A`,
      );

      // Create skill-b
      const skillB = path.join(discoveryDir, 'skill-b');
      fs.mkdirSync(skillB);
      fs.writeFileSync(
        path.join(skillB, 'SKILL.md'),
        `---
name: skill-b
description: Second skill
---

# Skill B`,
      );

      // Create a directory without SKILL.md (should be ignored)
      const notASkill = path.join(discoveryDir, 'not-a-skill');
      fs.mkdirSync(notASkill);
      fs.writeFileSync(path.join(notASkill, 'README.md'), '# Not a skill');

      // Create a file (not directory, should be ignored)
      fs.writeFileSync(path.join(discoveryDir, 'some-file.txt'), 'content');
    });

    it('discovers all valid skills in directory', () => {
      const discovered = discoverSkillsInDirectory(discoveryDir);

      assert.strictEqual(discovered.length, 2);
      const names = discovered.map((s) => s.name).sort();
      assert.deepStrictEqual(names, ['skill-a', 'skill-b']);
    });

    it('returns skill metadata with correct paths', () => {
      const discovered = discoverSkillsInDirectory(discoveryDir);
      const skillA = discovered.find((s) => s.name === 'skill-a');

      assert.ok(skillA);
      assert.ok(skillA.path.endsWith('skill-a'));
      assert.ok(skillA.skillMdPath.endsWith('SKILL.md'));
    });

    it('returns empty array for non-existent directory', () => {
      const nonExistent = path.join(testDir, 'does-not-exist');
      const discovered = discoverSkillsInDirectory(nonExistent);

      assert.deepStrictEqual(discovered, []);
    });

    it('returns empty array for empty directory', () => {
      const emptyDir = path.join(testDir, 'empty-dir');
      fs.mkdirSync(emptyDir, { recursive: true });

      const discovered = discoverSkillsInDirectory(emptyDir);

      assert.deepStrictEqual(discovered, []);
    });

    it('ignores directories without SKILL.md', () => {
      const discovered = discoverSkillsInDirectory(discoveryDir);
      const notASkill = discovered.find((s) => s.name === 'not-a-skill');

      assert.strictEqual(notASkill, undefined);
    });

    it('ignores files (non-directories)', () => {
      const discovered = discoverSkillsInDirectory(discoveryDir);

      // Should only have 2 skills, not pick up the file
      assert.strictEqual(discovered.length, 2);
    });

    it('skips skills with invalid frontmatter', () => {
      // Create a skill with invalid SKILL.md
      const invalidDir = path.join(testDir, 'with-invalid');
      fs.mkdirSync(invalidDir, { recursive: true });

      const validSkill = path.join(invalidDir, 'valid-skill');
      fs.mkdirSync(validSkill);
      fs.writeFileSync(
        path.join(validSkill, 'SKILL.md'),
        `---
name: valid
description: Valid skill
---

Body`,
      );

      const invalidSkill = path.join(invalidDir, 'invalid-skill');
      fs.mkdirSync(invalidSkill);
      fs.writeFileSync(
        path.join(invalidSkill, 'SKILL.md'),
        'No frontmatter here',
      );

      const discovered = discoverSkillsInDirectory(invalidDir);

      // Should only discover the valid skill
      assert.strictEqual(discovered.length, 1);
      assert.strictEqual(discovered[0].name, 'valid');
    });
  });

  describe('skills() fragment', () => {
    let fragmentDir: string;

    before(() => {
      // Create skills for fragment testing
      fragmentDir = path.join(testDir, 'fragments');
      fs.mkdirSync(fragmentDir, { recursive: true });

      // Create multiple skills
      for (const name of ['dev', 'deploy', 'test', 'docs']) {
        const skillDir = path.join(fragmentDir, name);
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          `---
name: ${name}
description: ${name.charAt(0).toUpperCase() + name.slice(1)} skill
---

# ${name} Skill`,
        );
      }
    });

    it('creates available_skills fragment with instructions', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/skills/local' }],
      });

      assert.strictEqual(fragment.name, 'available_skills');
      assert.ok(Array.isArray(fragment.data));

      // First item should be instructions
      const data = fragment.data as ContextFragment[];
      assert.strictEqual(data[0].name, 'instructions');
      assert.ok(
        (data[0].data as string).includes('SKILL.md'),
        'instructions should mention SKILL.md',
      );
    });

    it('remaps host paths to sandbox paths', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/sandbox/skills' }],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragments = data.filter((f) => f.name === 'skill');

      // All skills should have sandbox paths
      for (const skill of skillFragments) {
        const skillData = skill.data as { path: string };
        assert.ok(
          skillData.path.startsWith('/sandbox/skills'),
          `Expected sandbox path, got: ${skillData.path}`,
        );
      }
    });

    it('stores skill mounts in parent metadata', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/skills/mounted' }],
      });

      // Parent fragment should have mounts array in metadata
      assert.ok(fragment.metadata, 'fragment should have metadata');
      const mounts = (
        fragment.metadata as {
          mounts: { name: string; host: string; sandbox: string }[];
        }
      ).mounts;
      assert.ok(Array.isArray(mounts), 'metadata should have mounts array');
      assert.ok(mounts.length > 0, 'mounts should not be empty');

      // All mounts should have name, host, and sandbox
      for (const mount of mounts) {
        assert.ok(mount.name, 'mount should have name');
        assert.ok(mount.host, 'mount should have host');
        assert.ok(mount.sandbox, 'mount should have sandbox');
        assert.ok(
          mount.host.startsWith(fragmentDir),
          'host should contain original path',
        );
      }
    });

    it('includes skill name and description in fragment data', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/skills' }],
      });

      const data = fragment.data as ContextFragment[];
      const devSkill = data.find(
        (f) =>
          f.name === 'skill' && (f.data as { name: string }).name === 'dev',
      );

      assert.ok(devSkill, 'should find dev skill');
      const skillData = devSkill.data as {
        name: string;
        description: string;
        path: string;
      };
      assert.strictEqual(skillData.name, 'dev');
      assert.strictEqual(skillData.description, 'Dev skill');
      assert.ok(skillData.path.includes('/skills'));
    });

    it('filters skills by include list', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/skills' }],
        include: ['dev', 'test'],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragments = data.filter((f) => f.name === 'skill');
      const names = skillFragments.map(
        (f) => (f.data as { name: string }).name,
      );

      assert.strictEqual(skillFragments.length, 2);
      assert.ok(names.includes('dev'));
      assert.ok(names.includes('test'));
      assert.ok(!names.includes('deploy'));
      assert.ok(!names.includes('docs'));
    });

    it('filters skills by exclude list', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/skills' }],
        exclude: ['deploy', 'docs'],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragments = data.filter((f) => f.name === 'skill');
      const names = skillFragments.map(
        (f) => (f.data as { name: string }).name,
      );

      assert.strictEqual(skillFragments.length, 2);
      assert.ok(names.includes('dev'));
      assert.ok(names.includes('test'));
      assert.ok(!names.includes('deploy'));
      assert.ok(!names.includes('docs'));
    });

    it('applies both include and exclude filters', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/skills' }],
        include: ['dev', 'test', 'deploy'],
        exclude: ['deploy'],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragments = data.filter((f) => f.name === 'skill');
      const names = skillFragments.map(
        (f) => (f.data as { name: string }).name,
      );

      // Include restricts to [dev, test, deploy], exclude removes deploy
      assert.strictEqual(skillFragments.length, 2);
      assert.ok(names.includes('dev'));
      assert.ok(names.includes('test'));
      assert.ok(!names.includes('deploy'));
    });

    it('handles multiple skill paths', () => {
      // Create a second skills directory
      const secondDir = path.join(testDir, 'second-skills');
      fs.mkdirSync(secondDir, { recursive: true });

      const customSkill = path.join(secondDir, 'custom');
      fs.mkdirSync(customSkill);
      fs.writeFileSync(
        path.join(customSkill, 'SKILL.md'),
        `---
name: custom
description: Custom skill from second directory
---

# Custom`,
      );

      const fragment = skills({
        paths: [
          { host: fragmentDir, sandbox: '/skills/primary' },
          { host: secondDir, sandbox: '/skills/secondary' },
        ],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragments = data.filter((f) => f.name === 'skill');

      // Should have skills from both directories
      assert.strictEqual(skillFragments.length, 5); // 4 from fragmentDir + 1 from secondDir

      // Verify paths are correctly mapped
      const customFragment = skillFragments.find(
        (f) => (f.data as { name: string }).name === 'custom',
      );
      assert.ok(customFragment);
      assert.ok(
        (customFragment.data as { path: string }).path.startsWith(
          '/skills/secondary',
        ),
      );
    });

    it('later paths override earlier paths for same skill name', () => {
      // Create two directories with a skill of the same name
      const firstDir = path.join(testDir, 'first');
      const secondDir2 = path.join(testDir, 'second2');

      for (const dir of [firstDir, secondDir2]) {
        fs.mkdirSync(dir, { recursive: true });
        const skillDir = path.join(dir, 'duplicate');
        fs.mkdirSync(skillDir);
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          `---
name: duplicate
description: From ${path.basename(dir)}
---

Body`,
        );
      }

      const fragment = skills({
        paths: [
          { host: firstDir, sandbox: '/skills/first' },
          { host: secondDir2, sandbox: '/skills/second' },
        ],
      });

      const data = fragment.data as ContextFragment[];
      const duplicateSkills = data.filter(
        (f) =>
          f.name === 'skill' &&
          (f.data as { name: string }).name === 'duplicate',
      );

      // Should only have one skill (later path wins)
      assert.strictEqual(duplicateSkills.length, 1);

      // The description should be from the second directory
      const skillData = duplicateSkills[0].data as { description: string };
      assert.strictEqual(skillData.description, 'From second2');
    });

    it('returns empty skills list for non-existent directory', () => {
      const fragment = skills({
        paths: [{ host: '/nonexistent/path', sandbox: '/skills' }],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragments = data.filter((f) => f.name === 'skill');

      // Should still have instructions but no skills
      assert.ok(data.find((f) => f.name === 'instructions'));
      assert.strictEqual(skillFragments.length, 0);
    });

    it('handles include filter with non-existent skill names', () => {
      const fragment = skills({
        paths: [{ host: fragmentDir, sandbox: '/skills' }],
        include: ['dev', 'nonexistent'],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragments = data.filter((f) => f.name === 'skill');

      // Should only include 'dev' (nonexistent is ignored)
      assert.strictEqual(skillFragments.length, 1);
      assert.strictEqual(
        (skillFragments[0].data as { name: string }).name,
        'dev',
      );
    });
  });

  describe('path remapping edge cases', () => {
    let edgeCaseDir: string;

    before(() => {
      edgeCaseDir = path.join(testDir, 'edge-cases');
      fs.mkdirSync(edgeCaseDir, { recursive: true });

      const skill = path.join(edgeCaseDir, 'edge-skill');
      fs.mkdirSync(skill);
      fs.writeFileSync(
        path.join(skill, 'SKILL.md'),
        `---
name: edge-skill
description: Edge case skill
---

Body`,
      );
    });

    it('handles sandbox path without trailing slash', () => {
      const fragment = skills({
        paths: [{ host: edgeCaseDir, sandbox: '/skills' }],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragment = data.find((f) => f.name === 'skill');
      const skillPath = (skillFragment?.data as { path: string }).path;

      // Path should be properly formed without double slashes
      assert.ok(!skillPath.includes('//'), 'should not have double slashes');
      assert.ok(
        skillPath.startsWith('/skills/'),
        'should start with sandbox path',
      );
    });

    it('handles host path without trailing slash', () => {
      const fragment = skills({
        paths: [{ host: edgeCaseDir, sandbox: '/mounted' }],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragment = data.find((f) => f.name === 'skill');
      const skillPath = (skillFragment?.data as { path: string }).path;

      assert.ok(skillPath.startsWith('/mounted'));
    });

    it('sandbox path replaces host path prefix exactly', () => {
      const fragment = skills({
        paths: [{ host: edgeCaseDir, sandbox: '/replaced' }],
      });

      const data = fragment.data as ContextFragment[];
      const skillFragment = data.find((f) => f.name === 'skill');
      const skillPath = (skillFragment?.data as { path: string }).path;

      // The edgeCaseDir prefix should be completely replaced
      assert.ok(!skillPath.includes(edgeCaseDir));
      assert.ok(skillPath.startsWith('/replaced'));
    });
  });
});
