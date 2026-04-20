import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  discoverSkillsInDirectory,
  loadSkillMetadata,
  parseFrontmatter,
} from '@deepagents/context';

/**
 * Unit tests for the skill loader helpers (frontmatter + discovery).
 * The `skills()` fragment itself is a thin projection of `sandbox.skills`
 * and is covered end-to-end in `packages/context/test/bash-sandbox-skills.integration.test.ts`.
 */
describe('Skills Loader', () => {
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
});
