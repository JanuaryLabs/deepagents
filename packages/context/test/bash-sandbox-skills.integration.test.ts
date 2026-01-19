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
