import { createBashTool } from 'bash-tool';
import {
  Bash,
  InMemoryFs,
  MountableFs,
  OverlayFs,
  ReadWriteFs,
} from 'just-bash';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createBashTool as createBashToolV2 } from '@deepagents/context';

/**
 * Integration tests for just-bash filesystem mounting with skills.
 *
 * These tests reproduce the "no such file or directory" bug reported by a client
 * when using MountableFs + OverlayFs with skill directories.
 *
 * Root cause: Two issues in the client's code:
 * 1. `fsMounts` was created but never used in MountableFs configuration
 * 2. Missing `mountPoint: '/'` in OverlayFs causes files to appear at wrong paths
 *    (e.g., /skills/home/user/project/... instead of /skills/...)
 */
describe('bash sandbox skills mounting', () => {
  const testDir = path.join(process.cwd(), '.test-bash-sandbox');
  const skillsDir = path.join(testDir, 'skills');
  const artifactsDir = path.join(testDir, 'artifacts');

  beforeEach(async () => {
    // Create test directory structure mimicking a real skills setup
    await fs.mkdir(path.join(skillsDir, 'research-grants'), {
      recursive: true,
    });
    await fs.mkdir(artifactsDir, { recursive: true });

    // Create a test SKILL.md file
    await fs.writeFile(
      path.join(skillsDir, 'research-grants', 'SKILL.md'),
      `---
name: research-grants
description: Research grant application assistant
---

# Research Grants Skill

This skill helps with grant applications.`,
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /**
   * Reproduces the client's bug: fsMounts created but not used.
   *
   * The client's code created skillMounts -> fsMounts but then never
   * included fsMounts in the MountableFs configuration.
   */
  it('FAILS: demonstrates bug when fsMounts is created but not used', async () => {
    // This is the BUGGY pattern from client's code
    const listOfSkills = [
      {
        name: 'research-grants',
        path: path.join(skillsDir, 'research-grants'),
      },
    ];

    const skillMounts = listOfSkills.map((skill) => ({
      host: skill.path,
      sandbox: `/${skill.name}`,
    }));

    // fsMounts is created but NEVER USED - this is the bug!
    const _fsMounts = skillMounts.map(({ host, sandbox }) => ({
      mountPoint: sandbox,
      filesystem: new OverlayFs({
        root: host,
        mountPoint: '/skills', // Also wrong - should be '/'
        readOnly: true,
      }),
    }));

    // The filesystem is created WITHOUT the skill mounts
    const filesystem = new MountableFs({
      base: new InMemoryFs(),
      mounts: [
        {
          mountPoint: '/artifacts',
          filesystem: new ReadWriteFs({ root: artifactsDir }),
        },
        // BUG: fsMounts is NOT included here!
      ],
    });

    const bashInstance = new Bash({ fs: filesystem });

    const { sandbox } = await createBashTool({
      sandbox: bashInstance,
      destination: '/',
    });

    // This will fail because skills were never mounted
    const result = await sandbox.executeCommand(
      'cat /skills/research-grants/SKILL.md',
    );

    // The bug: exit code is non-zero (file not found)
    assert.notStrictEqual(
      result.exitCode,
      0,
      'Bug demonstration: should fail because fsMounts was not used',
    );
    assert.ok(
      result.stderr.includes('No such file or directory') ||
        result.stderr.includes('ENOENT'),
      `Expected 'No such file or directory' error, got: ${result.stderr}`,
    );
  });

  /**
   * Reproduces the second bug: wrong mountPoint in OverlayFs.
   *
   * When OverlayFs is created without `mountPoint: '/'`, files appear
   * at /skills/home/user/project/... instead of /skills/...
   */
  it('FAILS: demonstrates bug when OverlayFs uses wrong mountPoint', async () => {
    const listOfSkills = [
      {
        name: 'research-grants',
        path: path.join(skillsDir, 'research-grants'),
      },
    ];

    // Create mounts with WRONG mountPoint (using default or explicit non-root)
    const fsMounts = listOfSkills.map((skill) => ({
      mountPoint: `/skills/${skill.name}`,
      filesystem: new OverlayFs({
        root: skill.path,
        // BUG: mountPoint defaults to '/home/user/project' if not specified
        // or using a non-root value like '/skills'
        mountPoint: '/home/user/project', // Simulating the default behavior
        readOnly: true,
      }),
    }));

    const filesystem = new MountableFs({
      base: new InMemoryFs(),
      mounts: [
        ...fsMounts, // Now we're using it, but mountPoint is wrong
        {
          mountPoint: '/artifacts',
          filesystem: new ReadWriteFs({ root: artifactsDir }),
        },
      ],
    });

    const bashInstance = new Bash({ fs: filesystem });

    const { sandbox } = await createBashTool({
      sandbox: bashInstance,
      destination: '/',
    });

    // The expected path won't work because of wrong mountPoint
    const correctPath = await sandbox.executeCommand(
      'cat /skills/research-grants/SKILL.md',
    );

    // Files appear at the WRONG path
    assert.notStrictEqual(
      correctPath.exitCode,
      0,
      'Bug demonstration: correct path fails due to mountPoint issue',
    );

    // The files actually appear at a nested path
    const wrongPath = await sandbox.executeCommand(
      'cat /skills/research-grants/home/user/project/SKILL.md',
    );

    assert.strictEqual(
      wrongPath.exitCode,
      0,
      `Bug demonstration: files appear at wrong nested path. stderr: ${wrongPath.stderr}`,
    );
  });

  /**
   * The CORRECT way to mount skills with just-bash.
   *
   * Key fixes:
   * 1. Actually include fsMounts in MountableFs configuration
   * 2. Use `mountPoint: '/'` in OverlayFs so files appear at root of the mount
   */
  it('SUCCESS: correct way to mount skills with mountPoint: "/"', async () => {
    const listOfSkills = [
      {
        name: 'research-grants',
        path: path.join(skillsDir, 'research-grants'),
      },
    ];

    // Create mounts with CORRECT mountPoint: '/'
    const fsMounts = listOfSkills.map((skill) => ({
      mountPoint: `/skills/${skill.name}`,
      filesystem: new OverlayFs({
        root: skill.path,
        mountPoint: '/', // FIX: Use root so files appear directly at mount point
        readOnly: true,
      }),
    }));

    const filesystem = new MountableFs({
      base: new InMemoryFs(),
      mounts: [
        ...fsMounts, // FIX: Actually use the mounts!
        {
          mountPoint: '/artifacts',
          filesystem: new ReadWriteFs({ root: artifactsDir }),
        },
      ],
    });

    const bashInstance = new Bash({ fs: filesystem });

    const { sandbox } = await createBashTool({
      sandbox: bashInstance,
      destination: '/',
    });

    // Now the correct path works
    const result = await sandbox.executeCommand(
      'cat /skills/research-grants/SKILL.md',
    );

    assert.strictEqual(
      result.exitCode,
      0,
      `Expected exit code 0, got ${result.exitCode}. stderr: ${result.stderr}`,
    );
    assert.ok(
      result.stdout.includes('# Research Grants Skill'),
      'Should be able to read skill content',
    );
  });

  /**
   * Test the exact pattern from the working createResultTools implementation.
   */
  it('SUCCESS: matches createResultTools pattern from text2sql', async () => {
    const skillMounts = [{ host: skillsDir, sandbox: '/skills/skills' }];

    // This is the CORRECT pattern from createResultTools
    const fsMounts = skillMounts.map(({ host, sandbox }) => ({
      mountPoint: sandbox,
      filesystem: new OverlayFs({
        root: host,
        mountPoint: '/', // Key fix!
        readOnly: true,
      }),
    }));

    const filesystem = new MountableFs({
      base: new InMemoryFs(),
      mounts: [
        ...fsMounts,
        {
          mountPoint: '/artifacts',
          filesystem: new ReadWriteFs({ root: artifactsDir }),
        },
      ],
    });

    const bashInstance = new Bash({ fs: filesystem });

    const { sandbox } = await createBashTool({
      sandbox: bashInstance,
      destination: '/',
    });

    // Verify directory structure
    const lsRoot = await sandbox.executeCommand('ls /');
    assert.strictEqual(lsRoot.exitCode, 0);
    assert.ok(lsRoot.stdout.includes('skills'), 'Should have /skills mount');
    assert.ok(
      lsRoot.stdout.includes('artifacts'),
      'Should have /artifacts mount',
    );

    // Navigate into skills
    const lsSkills = await sandbox.executeCommand('ls /skills');
    assert.strictEqual(lsSkills.exitCode, 0);
    assert.ok(lsSkills.stdout.includes('skills'), 'Should have /skills/skills');

    // Navigate into skills/skills (the actual skills directory)
    const lsSkillsSkills = await sandbox.executeCommand('ls /skills/skills');
    assert.strictEqual(lsSkillsSkills.exitCode, 0);
    assert.ok(
      lsSkillsSkills.stdout.includes('research-grants'),
      'Should have research-grants skill',
    );

    // Read the skill file at the correct path
    const catResult = await sandbox.executeCommand(
      'cat /skills/skills/research-grants/SKILL.md',
    );
    assert.strictEqual(
      catResult.exitCode,
      0,
      `Failed to read SKILL.md. stderr: ${catResult.stderr}`,
    );
    assert.ok(catResult.stdout.includes('# Research Grants Skill'));
  });

  /**
   * Multiple skills mounted correctly.
   */
  it('SUCCESS: multiple skills mounted independently', async () => {
    // Create another skill
    const dataAnalysisDir = path.join(skillsDir, 'data-analysis');
    await fs.mkdir(dataAnalysisDir, { recursive: true });
    await fs.writeFile(
      path.join(dataAnalysisDir, 'SKILL.md'),
      `---
name: data-analysis
description: Data analysis skill
---

# Data Analysis Skill`,
    );

    const skillMounts = [
      {
        host: path.join(skillsDir, 'research-grants'),
        sandbox: '/skills/research-grants',
      },
      { host: dataAnalysisDir, sandbox: '/skills/data-analysis' },
    ];

    const fsMounts = skillMounts.map(({ host, sandbox }) => ({
      mountPoint: sandbox,
      filesystem: new OverlayFs({
        root: host,
        mountPoint: '/',
        readOnly: true,
      }),
    }));

    const filesystem = new MountableFs({
      base: new InMemoryFs(),
      mounts: fsMounts,
    });

    const bashInstance = new Bash({ fs: filesystem });

    const { sandbox } = await createBashTool({
      sandbox: bashInstance,
      destination: '/',
    });

    // Both skills should be accessible
    const researchResult = await sandbox.executeCommand(
      'cat /skills/research-grants/SKILL.md',
    );
    assert.strictEqual(researchResult.exitCode, 0);
    assert.ok(researchResult.stdout.includes('# Research Grants Skill'));

    const analysisResult = await sandbox.executeCommand(
      'cat /skills/data-analysis/SKILL.md',
    );
    assert.strictEqual(analysisResult.exitCode, 0);
    assert.ok(analysisResult.stdout.includes('# Data Analysis Skill'));
  });

  /**
   * Skills are read-only - cannot write to them.
   */
  it('SUCCESS: skills are read-only', async () => {
    const fsMounts = [
      {
        mountPoint: '/skills/research-grants',
        filesystem: new OverlayFs({
          root: path.join(skillsDir, 'research-grants'),
          mountPoint: '/',
          readOnly: true,
        }),
      },
    ];

    const filesystem = new MountableFs({
      base: new InMemoryFs(),
      mounts: fsMounts,
    });

    const bashInstance = new Bash({ fs: filesystem });

    const { sandbox } = await createBashTool({
      sandbox: bashInstance,
      destination: '/',
    });

    // Attempting to write should fail
    await assert.rejects(
      () =>
        sandbox.executeCommand(
          'echo "hacked" > /skills/research-grants/hack.txt',
        ),
      /EROFS|read-only/,
      'Should not be able to write to read-only skill directory',
    );
  });
});

/**
 * Integration tests for the v2 skills API: sandbox factories (`createBashTool`,
 * `createContainerTool`) accept `skills: [{ host, sandbox }]` and populate
 * `sandbox.skills`. These cover scenarios previously tested at the
 * `skills()` fragment level (before the fragment became a thin projection of
 * `sandbox.skills`): multi-path discovery, later-overrides-earlier, path
 * remapping, non-existent directories, and walk filtering.
 */
describe('createBashTool with skills option', () => {
  const testRoot = path.join(process.cwd(), '.test-sandbox-skills-v2');

  beforeEach(async () => {
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  async function writeSkill(dir: string, name: string, description: string) {
    const skillDir = path.join(dir, name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
  }

  it('uploads files and populates sandbox.skills from a single host dir', async () => {
    const skillsDir = path.join(testRoot, 'skills');
    await writeSkill(skillsDir, 'dev', 'Dev skill');
    await writeSkill(skillsDir, 'deploy', 'Deploy skill');

    const sandbox = await createBashToolV2({
      skills: [{ host: skillsDir, sandbox: '/workspace/skills' }],
    });

    assert.strictEqual(sandbox.skills.length, 2);
    const names = sandbox.skills.map((s) => s.name).sort();
    assert.deepStrictEqual(names, ['deploy', 'dev']);

    for (const mount of sandbox.skills) {
      assert.ok(
        mount.sandbox.startsWith('/workspace/skills/'),
        `expected sandbox path prefix, got ${mount.sandbox}`,
      );
      assert.ok(mount.sandbox.endsWith('/SKILL.md'));
    }

    const dev = sandbox.skills.find((s) => s.name === 'dev')!;
    const content = await sandbox.sandbox.readFile(dev.sandbox);
    assert.ok(content.includes('# dev'));
  });

  it('handles multiple skill paths and maps each to its own sandbox prefix', async () => {
    const primary = path.join(testRoot, 'primary');
    const secondary = path.join(testRoot, 'secondary');
    await writeSkill(primary, 'dev', 'Dev from primary');
    await writeSkill(secondary, 'extra', 'Extra from secondary');

    const sandbox = await createBashToolV2({
      skills: [
        { host: primary, sandbox: '/skills/primary' },
        { host: secondary, sandbox: '/skills/secondary' },
      ],
    });

    const dev = sandbox.skills.find((s) => s.name === 'dev');
    const extra = sandbox.skills.find((s) => s.name === 'extra');
    assert.ok(dev && dev.sandbox.startsWith('/skills/primary/'));
    assert.ok(extra && extra.sandbox.startsWith('/skills/secondary/'));
  });

  it('later skill inputs override earlier ones for the same skill name', async () => {
    const first = path.join(testRoot, 'first');
    const second = path.join(testRoot, 'second');
    await writeSkill(first, 'shared', 'From first');
    await writeSkill(second, 'shared', 'From second');

    const sandbox = await createBashToolV2({
      skills: [
        { host: first, sandbox: '/skills/first' },
        { host: second, sandbox: '/skills/second' },
      ],
    });

    const shared = sandbox.skills.filter((s) => s.name === 'shared');
    assert.strictEqual(shared.length, 1, 'later input should replace earlier');
    assert.strictEqual(shared[0].description, 'From second');
    assert.ok(shared[0].sandbox.startsWith('/skills/second/'));
  });

  it('returns an empty skills array for a non-existent host directory', async () => {
    const sandbox = await createBashToolV2({
      skills: [
        {
          host: path.join(testRoot, 'does-not-exist'),
          sandbox: '/workspace/skills',
        },
      ],
    });

    assert.deepStrictEqual(sandbox.skills, []);
  });

  it('defaults sandbox.skills to [] when no skills option is passed', async () => {
    const sandbox = await createBashToolV2();
    assert.deepStrictEqual(sandbox.skills, []);
  });

  it('walks subdirectories (references/scripts/assets) and uploads them', async () => {
    const skillsDir = path.join(testRoot, 'walk');
    const skillDir = path.join(skillsDir, 'demo');
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: demo\ndescription: demo skill\n---\n\nBody`,
    );
    await fs.writeFile(
      path.join(skillDir, 'scripts', 'run.sh'),
      '#!/bin/sh\necho hello\n',
    );

    const sandbox = await createBashToolV2({
      skills: [{ host: skillsDir, sandbox: '/skills' }],
    });

    const script = await sandbox.sandbox.readFile(
      '/skills/demo/scripts/run.sh',
    );
    assert.ok(script.includes('echo hello'));
  });

  it('skips dotfiles and dot-directories during walk', async () => {
    const skillsDir = path.join(testRoot, 'with-dots');
    const skillDir = path.join(skillsDir, 'demo');
    await fs.mkdir(path.join(skillDir, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: demo\ndescription: d\n---\n\nBody`,
    );
    await fs.writeFile(path.join(skillDir, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(skillDir, '.git', 'HEAD'), 'ref: whatever');

    const sandbox = await createBashToolV2({
      skills: [{ host: skillsDir, sandbox: '/skills' }],
    });

    await assert.rejects(() => sandbox.sandbox.readFile('/skills/demo/.env'));
    await assert.rejects(() =>
      sandbox.sandbox.readFile('/skills/demo/.git/HEAD'),
    );
  });
});
