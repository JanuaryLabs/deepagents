import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createResultTools } from '@deepagents/text2sql';

import { init_db } from '../../tests/sqlite.ts';

describe('createResultTools sandbox isolation', () => {
  const testDir = path.join(process.cwd(), '.test-sandbox');
  const skillsDir = path.join(testDir, 'skills');
  const otherChatDir = path.join(testDir, 'artifacts', 'other-chat-id');

  beforeEach(async () => {
    // Create test directory structure
    await fs.mkdir(path.join(skillsDir, 'test-skill'), { recursive: true });
    await fs.mkdir(otherChatDir, { recursive: true });

    // Create a test skill file
    await fs.writeFile(
      path.join(skillsDir, 'test-skill', 'SKILL.md'),
      '---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\nThis is a test skill.',
    );

    // Create a file in another chat's artifacts (should not be accessible)
    await fs.writeFile(
      path.join(otherChatDir, 'secret.json'),
      '{"secret": "should-not-be-accessible"}',
    );

    // Create a file in project root (should not be accessible)
    await fs.writeFile(
      path.join(testDir, 'root-file.txt'),
      'This is a root file',
    );
  });

  afterEach(async () => {
    // Cleanup test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('can read skills from mounted skill directories', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // First check the mount structure
    const lsRoot = await sandbox.executeCommand('ls /skills');
    // Mount point is /skills/{basename} = /skills/skills
    // Inside that, we have the content of skillsDir which contains test-skill/SKILL.md
    const lsSkills = await sandbox.executeCommand('ls /skills/skills');

    // Read skill file through the sandbox
    const result = await sandbox.executeCommand(
      'cat /skills/skills/test-skill/SKILL.md',
    );

    assert.strictEqual(
      result.exitCode,
      0,
      `Expected exit code 0, got ${result.exitCode}. stderr: ${result.stderr}\nls /skills: ${lsRoot.stdout}\nls /skills/skills: ${lsSkills.stdout}`,
    );
    assert.ok(
      result.stdout.includes('# Test Skill'),
      'Should be able to read skill content',
    );
  });

  it('cannot access project root files', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // Try to read a file from project root
    const result = await sandbox.executeCommand(`cat ${testDir}/root-file.txt`);

    assert.notStrictEqual(
      result.exitCode,
      0,
      'Should not be able to access project root files',
    );
  });

  it('cannot access other chats artifacts', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // Try to access another chat's artifacts via path traversal
    const result = await sandbox.executeCommand(
      'cat /artifacts/../other-chat-id/secret.json',
    );

    assert.notStrictEqual(
      result.exitCode,
      0,
      'Should not be able to access other chat artifacts',
    );
  });

  it('can write to /results directory', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // Write a file to results
    const writeResult = await sandbox.executeCommand(
      'echo "test content" > /results/test.txt',
    );
    assert.strictEqual(
      writeResult.exitCode,
      0,
      `Write should succeed. stderr: ${writeResult.stderr}`,
    );

    // Read it back
    const readResult = await sandbox.executeCommand('cat /results/test.txt');
    assert.strictEqual(readResult.exitCode, 0);
    assert.ok(readResult.stdout.includes('test content'));
  });

  it('can write to /artifacts directory', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // Write a file to artifacts
    const writeResult = await sandbox.executeCommand(
      'echo "artifact content" > /artifacts/artifact.txt',
    );
    assert.strictEqual(
      writeResult.exitCode,
      0,
      `Write should succeed. stderr: ${writeResult.stderr}`,
    );

    // Read it back
    const readResult = await sandbox.executeCommand(
      'cat /artifacts/artifact.txt',
    );
    assert.strictEqual(readResult.exitCode, 0);
    assert.ok(readResult.stdout.includes('artifact content'));
  });

  it('cannot write to skills directory (read-only)', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // Try to write to skills directory - should throw EROFS error
    await assert.rejects(
      () =>
        sandbox.executeCommand('echo "malicious" > /skills/skills/hack.txt'),
      /EROFS|read-only/,
      'Should not be able to write to skills directory',
    );
  });

  it('lists only mounted directories at root', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    const result = await sandbox.executeCommand('ls /');

    assert.strictEqual(result.exitCode, 0);
    // Should see skills, results, artifacts - nothing else
    assert.ok(result.stdout.includes('skills'), 'Should have /skills mount');
    assert.ok(result.stdout.includes('results'), 'Should have /results mount');
    assert.ok(
      result.stdout.includes('artifacts'),
      'Should have /artifacts mount',
    );
  });

  it('handles empty skillPaths gracefully', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
    });

    // Should still work, just no skills mounted
    const result = await sandbox.executeCommand('ls /');

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('results'), 'Should have /results mount');
    assert.ok(
      result.stdout.includes('artifacts'),
      'Should have /artifacts mount',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution Edge Cases
// Tests for the mountPoint: '/' fix that prevents files appearing at wrong paths
// ─────────────────────────────────────────────────────────────────────────────

describe('path resolution edge cases', () => {
  const testDir = path.join(process.cwd(), '.test-path-resolution');
  const skillsDir = path.join(testDir, 'skills');

  beforeEach(async () => {
    await fs.mkdir(path.join(skillsDir, 'my-skill'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'my-skill', 'SKILL.md'),
      '# My Skill Content',
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('skills appear at correct path with mountPoint: "/" fix (not /home/user/project/...)', async () => {
    // This test verifies the fix for OverlayFs default mountPoint '/home/user/project'
    // Before fix: files appeared at /skills/skills/home/user/project/my-skill/SKILL.md
    // After fix: files appear at /skills/skills/my-skill/SKILL.md
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // The WRONG path (before fix) should NOT work
    const wrongPath = await sandbox.executeCommand(
      'cat /skills/skills/home/user/project/my-skill/SKILL.md',
    );
    assert.notStrictEqual(
      wrongPath.exitCode,
      0,
      'Files should NOT appear at /home/user/project/... path',
    );

    // The CORRECT path (after fix) SHOULD work
    const correctPath = await sandbox.executeCommand(
      'cat /skills/skills/my-skill/SKILL.md',
    );
    assert.strictEqual(
      correctPath.exitCode,
      0,
      `Correct path should work. stderr: ${correctPath.stderr}`,
    );
    assert.ok(correctPath.stdout.includes('# My Skill Content'));
  });

  it('relative paths work with cd command', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // cd to skills dir and use relative path
    const result = await sandbox.executeCommand(
      'cd /skills/skills && cat my-skill/SKILL.md',
    );

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('# My Skill Content'));
  });

  it('handles absolute paths to skill files', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    const result = await sandbox.executeCommand(
      'cat /skills/skills/my-skill/SKILL.md',
    );

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('# My Skill Content'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multiple Skill Directories
// Tests for mounting multiple independent skill directories
// ─────────────────────────────────────────────────────────────────────────────

describe('multiple skill directories', () => {
  const testDir = path.join(process.cwd(), '.test-multi-skills');
  const skillsDir1 = path.join(testDir, 'skills-a');
  const skillsDir2 = path.join(testDir, 'skills-b');

  beforeEach(async () => {
    // Create two separate skill directories
    await fs.mkdir(path.join(skillsDir1, 'skill-alpha'), { recursive: true });
    await fs.mkdir(path.join(skillsDir2, 'skill-beta'), { recursive: true });

    await fs.writeFile(
      path.join(skillsDir1, 'skill-alpha', 'SKILL.md'),
      '# Alpha Skill',
    );
    await fs.writeFile(
      path.join(skillsDir2, 'skill-beta', 'SKILL.md'),
      '# Beta Skill',
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('mounts multiple skill directories independently', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [
        { host: skillsDir1, sandbox: '/skills/skills-a' },
        { host: skillsDir2, sandbox: '/skills/skills-b' },
      ],
    });

    // Both skill directories should be mounted
    const lsSkills = await sandbox.executeCommand('ls /skills');
    assert.strictEqual(lsSkills.exitCode, 0);
    assert.ok(
      lsSkills.stdout.includes('skills-a'),
      'Should have skills-a mount',
    );
    assert.ok(
      lsSkills.stdout.includes('skills-b'),
      'Should have skills-b mount',
    );

    // Access skill from first directory
    const alpha = await sandbox.executeCommand(
      'cat /skills/skills-a/skill-alpha/SKILL.md',
    );
    assert.strictEqual(alpha.exitCode, 0);
    assert.ok(alpha.stdout.includes('# Alpha Skill'));

    // Access skill from second directory
    const beta = await sandbox.executeCommand(
      'cat /skills/skills-b/skill-beta/SKILL.md',
    );
    assert.strictEqual(beta.exitCode, 0);
    assert.ok(beta.stdout.includes('# Beta Skill'));
  });

  it('handles overlapping skill names in different directories', async () => {
    // Add a skill with same name to both directories
    await fs.mkdir(path.join(skillsDir1, 'common'), { recursive: true });
    await fs.mkdir(path.join(skillsDir2, 'common'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir1, 'common', 'SKILL.md'),
      '# Common from A',
    );
    await fs.writeFile(
      path.join(skillsDir2, 'common', 'SKILL.md'),
      '# Common from B',
    );

    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [
        { host: skillsDir1, sandbox: '/skills/skills-a' },
        { host: skillsDir2, sandbox: '/skills/skills-b' },
      ],
    });

    // Each common skill should be accessible at its own mount point
    const commonA = await sandbox.executeCommand(
      'cat /skills/skills-a/common/SKILL.md',
    );
    assert.strictEqual(commonA.exitCode, 0);
    assert.ok(commonA.stdout.includes('# Common from A'));

    const commonB = await sandbox.executeCommand(
      'cat /skills/skills-b/common/SKILL.md',
    );
    assert.strictEqual(commonB.exitCode, 0);
    assert.ok(commonB.stdout.includes('# Common from B'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL Command Integration
// Tests for the sql run/validate commands within the sandbox
// ─────────────────────────────────────────────────────────────────────────────

describe('sql command integration', () => {
  const testDir = path.join(process.cwd(), '.test-sql-integration');

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('sql run writes results and returns /artifacts path', async () => {
    const mockRows = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];
    const sqlAdapter = {
      execute: async () => mockRows,
      validate: async () => undefined,
      introspect: async () => ({ tables: [], enums: [] }),
    };

    const { sandbox } = await createResultTools({
      adapter: sqlAdapter,
      chatId: 'test-chat',
      messageId: 'test-message',
    });

    // Execute SQL
    const result = await sandbox.executeCommand(
      'sql run "SELECT * FROM users"',
    );

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('/artifacts/'),
      'Should output cross-turn accessible path',
    );
    assert.ok(result.stdout.includes('rows: 2'), 'Should show row count');
  });

  it('sql run results are readable via returned path', async () => {
    const mockRows = [{ value: 42 }];
    const sqlAdapter = {
      execute: async () => mockRows,
      validate: async () => undefined,
      introspect: async () => ({ tables: [], enums: [] }),
    };

    const { sandbox } = await createResultTools({
      adapter: sqlAdapter,
      chatId: 'test-chat',
      messageId: 'test-message',
    });

    // Execute SQL and capture the output path
    const sqlResult = await sandbox.executeCommand(
      'sql run "SELECT 42 as value"',
    );
    assert.strictEqual(sqlResult.exitCode, 0);

    // Extract the file path from output (first line: "results stored in <path>")
    const firstLine = sqlResult.stdout.split('\n')[0].trim();
    const filePath = firstLine.replace('results stored in ', '');
    assert.ok(
      filePath.startsWith('/artifacts/'),
      'Path should be in /artifacts',
    );

    // Read the result file
    const catResult = await sandbox.executeCommand(`cat ${filePath}`);
    assert.strictEqual(catResult.exitCode, 0);
    assert.ok(catResult.stdout.includes('"value": 42'));
  });

  it('sql run results are accessible across turns via /artifacts', async () => {
    const mockRows = [{ id: 1, name: 'Test' }];
    const sqlAdapter = {
      execute: async () => mockRows,
      validate: async () => undefined,
      introspect: async () => ({ tables: [], enums: [] }),
    };

    // Turn 1: Execute SQL and get path
    const { sandbox: sandbox1 } = await createResultTools({
      adapter: sqlAdapter,
      chatId: 'test-chat',
      messageId: 'turn-1',
    });

    const sqlResult = await sandbox1.executeCommand(
      'sql run "SELECT * FROM users"',
    );
    assert.strictEqual(sqlResult.exitCode, 0);
    const firstLine = sqlResult.stdout.split('\n')[0].trim();
    const filePath = firstLine.replace('results stored in ', '');

    // Turn 2: New sandbox with different messageId
    const { sandbox: sandbox2 } = await createResultTools({
      adapter: sqlAdapter,
      chatId: 'test-chat',
      messageId: 'turn-2',
    });

    // Should be able to read file from turn 1 using the same path
    const catResult = await sandbox2.executeCommand(`cat ${filePath}`);
    assert.strictEqual(
      catResult.exitCode,
      0,
      `Should access turn-1 result from turn-2. stderr: ${catResult.stderr}`,
    );
    assert.ok(catResult.stdout.includes('"name": "Test"'));
  });

  it('sql validate returns valid for SELECT', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
    });

    const result = await sandbox.executeCommand('sql validate "SELECT 1"');

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('valid'));
  });

  it('sql validate rejects non-SELECT queries', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
    });

    const dropResult = await sandbox.executeCommand(
      'sql validate "DROP TABLE users"',
    );
    assert.notStrictEqual(dropResult.exitCode, 0, 'DROP should be rejected');

    const insertResult = await sandbox.executeCommand(
      'sql validate "INSERT INTO users VALUES (1)"',
    );
    assert.notStrictEqual(
      insertResult.exitCode,
      0,
      'INSERT should be rejected',
    );

    const updateResult = await sandbox.executeCommand(
      'sql validate "UPDATE users SET name = \'x\'"',
    );
    assert.notStrictEqual(
      updateResult.exitCode,
      0,
      'UPDATE should be rejected',
    );
  });

  it('sql run handles adapter errors gracefully', async () => {
    const errorAdapter = {
      execute: async () => {
        throw new Error('Connection timeout');
      },
      validate: async () => undefined,
      introspect: async () => ({ tables: [], enums: [] }),
    };

    const { sandbox } = await createResultTools({
      adapter: errorAdapter,
      chatId: 'test-chat',
      messageId: 'test-message',
    });

    const result = await sandbox.executeCommand('sql run "SELECT 1"');

    assert.notStrictEqual(result.exitCode, 0);
    assert.ok(result.stderr.includes('Connection timeout'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path Traversal Security
// Tests for various path traversal attack vectors
// ─────────────────────────────────────────────────────────────────────────────

describe('path traversal security', () => {
  const testDir = path.join(process.cwd(), '.test-security');
  const skillsDir = path.join(testDir, 'skills');

  beforeEach(async () => {
    await fs.mkdir(path.join(skillsDir, 'test-skill'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'test-skill', 'SKILL.md'),
      '# Skill',
    );

    // Create a sensitive file outside the sandbox
    await fs.writeFile(path.join(testDir, 'sensitive.txt'), 'SECRET DATA');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('blocks ../../ traversal from /artifacts', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    const result = await sandbox.executeCommand(
      'cat /artifacts/../../sensitive.txt',
    );

    assert.notStrictEqual(
      result.exitCode,
      0,
      'Path traversal should be blocked',
    );
  });

  it('blocks /../ traversal from /results', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    const result = await sandbox.executeCommand(
      'cat /results/../../../sensitive.txt',
    );

    assert.notStrictEqual(
      result.exitCode,
      0,
      'Path traversal should be blocked',
    );
  });

  it('blocks absolute paths outside mounts', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // Try to access /etc/passwd (common attack target)
    const etcResult = await sandbox.executeCommand('cat /etc/passwd');
    assert.notStrictEqual(
      etcResult.exitCode,
      0,
      '/etc/passwd should not be accessible',
    );

    // Try to access home directory
    const homeResult = await sandbox.executeCommand(
      'cat /home/user/project/file',
    );
    assert.notStrictEqual(
      homeResult.exitCode,
      0,
      '/home should not be accessible',
    );

    // Try to access the test sensitive file via absolute path
    const sensitiveResult = await sandbox.executeCommand(
      `cat ${testDir}/sensitive.txt`,
    );
    assert.notStrictEqual(
      sensitiveResult.exitCode,
      0,
      'Absolute paths outside sandbox should fail',
    );
  });

  it('blocks traversal via cd command', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    // Try to cd out of sandbox and access files
    const result = await sandbox.executeCommand(
      'cd /artifacts && cd ../.. && cat sensitive.txt',
    );

    assert.notStrictEqual(result.exitCode, 0, 'cd traversal should be blocked');
  });

  it('blocks access via skills mount traversal', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'test-chat',
      messageId: 'test-message',
      skillMounts: [{ host: skillsDir, sandbox: '/skills/skills' }],
    });

    const result = await sandbox.executeCommand(
      'cat /skills/skills/../../../sensitive.txt',
    );

    assert.notStrictEqual(
      result.exitCode,
      0,
      'Skills traversal should be blocked',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Artifacts Persistence
// Tests for files being written to the real filesystem
// ─────────────────────────────────────────────────────────────────────────────

describe('artifacts persistence to disk', () => {
  const testDir = path.join(process.cwd(), '.test-persistence');

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    // Also clean up artifacts directory
    await fs
      .rm(path.join(process.cwd(), 'artifacts', 'persist-chat'), {
        recursive: true,
        force: true,
      })
      .catch((error) => {
        void error;
      });
  });

  it('files written to /results appear on real filesystem', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'persist-chat',
      messageId: 'persist-message',
    });

    // Write file via sandbox
    await sandbox.executeCommand(
      'echo "persisted content" > /results/test.txt',
    );

    // Verify it exists on real filesystem
    const realPath = path.join(
      process.cwd(),
      'artifacts',
      'persist-chat',
      'persist-message',
      'results',
      'test.txt',
    );
    const content = await fs.readFile(realPath, 'utf-8');
    assert.ok(content.includes('persisted content'));
  });

  it('files written to /artifacts appear on real filesystem', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'persist-chat',
      messageId: 'persist-message',
    });

    // Write file via sandbox
    await sandbox.executeCommand('echo "artifact data" > /artifacts/data.json');

    // Verify it exists on real filesystem
    const realPath = path.join(
      process.cwd(),
      'artifacts',
      'persist-chat',
      'data.json',
    );
    const content = await fs.readFile(realPath, 'utf-8');
    assert.ok(content.includes('artifact data'));
  });

  it('results from previous turns are accessible in /artifacts', async () => {
    // First turn - write to results
    const { sandbox: sandbox1 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'persist-chat',
      messageId: 'turn-1',
    });
    await sandbox1.executeCommand('echo "turn 1 data" > /results/turn1.txt');

    // Second turn - should see first turn's results in artifacts
    const { sandbox: sandbox2 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      chatId: 'persist-chat',
      messageId: 'turn-2',
    });

    // List artifacts - should see turn-1 directory
    const lsResult = await sandbox2.executeCommand('ls /artifacts');
    assert.ok(
      lsResult.stdout.includes('turn-1'),
      'Should see previous turn directory',
    );

    // Read previous turn's results
    const catResult = await sandbox2.executeCommand(
      'cat /artifacts/turn-1/results/turn1.txt',
    );
    assert.strictEqual(catResult.exitCode, 0, `stderr: ${catResult.stderr}`);
    assert.ok(catResult.stdout.includes('turn 1 data'));
  });
});
