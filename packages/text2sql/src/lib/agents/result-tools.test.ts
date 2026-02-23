import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { InMemoryFs, ReadWriteFs } from 'just-bash';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { SkillPathMapping } from '@deepagents/context';
import { TrackedFs, createResultTools } from '@deepagents/text2sql';

import { init_db } from '../../tests/sqlite.ts';

/** Helper to create properly typed skill mount for tests */
const fakeSkillMount = (
  host: string,
  sandbox = '/skills/skills',
): SkillPathMapping => ({
  name: 'test-skill',
  description: 'Test skill for sandbox isolation',
  host,
  sandbox,
});

describe('createResultTools sandbox isolation', () => {
  const testDir = path.join(process.cwd(), '.test-sandbox');
  const skillsDir = path.join(testDir, 'skills');
  const otherChatDir = path.join(testDir, 'artifacts', 'other-chat-id');

  beforeEach(async () => {
    await fs.mkdir(path.join(skillsDir, 'test-skill'), { recursive: true });
    await fs.mkdir(otherChatDir, { recursive: true });

    await fs.writeFile(
      path.join(skillsDir, 'test-skill', 'SKILL.md'),
      '---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\nThis is a test skill.',
    );

    await fs.writeFile(
      path.join(otherChatDir, 'secret.json'),
      '{"secret": "should-not-be-accessible"}',
    );

    await fs.writeFile(
      path.join(testDir, 'root-file.txt'),
      'This is a root file',
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('can read skills from mounted skill directories', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

    const lsRoot = await sandbox.executeCommand('ls /skills');
    // Mount: /skills/{basename} → skillsDir containing test-skill/SKILL.md
    const lsSkills = await sandbox.executeCommand('ls /skills/skills');

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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

    const writeResult = await sandbox.executeCommand(
      'echo "test content" > /results/test.txt',
    );
    assert.strictEqual(
      writeResult.exitCode,
      0,
      `Write should succeed. stderr: ${writeResult.stderr}`,
    );

    const readResult = await sandbox.executeCommand('cat /results/test.txt');
    assert.strictEqual(readResult.exitCode, 0);
    assert.ok(readResult.stdout.includes('test content'));
  });

  it('can write to /artifacts directory', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

    const writeResult = await sandbox.executeCommand(
      'echo "artifact content" > /artifacts/artifact.txt',
    );
    assert.strictEqual(
      writeResult.exitCode,
      0,
      `Write should succeed. stderr: ${writeResult.stderr}`,
    );

    const readResult = await sandbox.executeCommand(
      'cat /artifacts/artifact.txt',
    );
    assert.strictEqual(readResult.exitCode, 0);
    assert.ok(readResult.stdout.includes('artifact content'));
  });

  it('cannot write to skills directory (read-only)', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand('ls /');

    assert.strictEqual(result.exitCode, 0);
    // Should see skills mount (results/artifacts go to base filesystem)
    assert.ok(result.stdout.includes('skills'), 'Should have /skills mount');
  });

  it('handles empty skillPaths gracefully', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand('ls /');
    assert.strictEqual(result.exitCode, 0);
  });
});

describe('bash tool reasoning contract', () => {
  const testUsage = {
    inputTokens: {
      total: 3,
      noCache: 3,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 10,
      text: 10,
      reasoning: undefined,
    },
  } as const;

  const createBashToolCallModel = (input: string) =>
    new MockLanguageModelV3({
      doGenerate: {
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: testUsage,
        warnings: [],
        content: [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: 'bash',
            input,
          },
        ],
      },
    });

  const runBashToolCall = async (input: string) => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await generateText({
      model: createBashToolCallModel(input),
      prompt: 'test-input',
      stopWhen: stepCountIs(1),
      tools: { bash: tools.bash },
    });

    return result.content as Array<{
      type: string;
      toolName?: string;
      error?: unknown;
      output?: {
        stdout: string;
        stderr: string;
        exitCode: number;
      };
    }>;
  };

  it('schema rejects missing reasoning', async () => {
    const content = await runBashToolCall(`{"command":"echo hello"}`);

    const toolError = content.find(
      (part) => part.type === 'tool-error' && part.toolName === 'bash',
    );
    assert.ok(toolError, 'Expected bash tool call to fail validation');
    assert.match(String(toolError.error), /reasoning/i);
  });

  it('schema accepts command with non-empty reasoning', async () => {
    const content = await runBashToolCall(
      `{"command":"echo hello","reasoning":"Read command output for report assembly."}`,
    );

    const toolError = content.find(
      (part) => part.type === 'tool-error' && part.toolName === 'bash',
    );
    assert.strictEqual(toolError, undefined);

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
  });

  it('execution succeeds and output shape is unchanged when reasoning is provided', async () => {
    const content = await runBashToolCall(
      `{"command":"echo hello","reasoning":"Verify wrapped bash execution path."}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
    assert.ok(toolResult.output, 'Expected bash tool output');
    assert.strictEqual(toolResult.output.exitCode, 0);
    assert.strictEqual(toolResult.output.stderr, '');
    assert.ok(toolResult.output.stdout.includes('hello'));
  });
});

describe('sql proxy enforcement', () => {
  it('blocks direct DB CLI via tool path and redirects to sql validate/run', async () => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const execute = tools.bash.execute!;
    const result = (await execute(
      {
        command: 'psql -c "SELECT 1"',
        reasoning: 'Try direct db CLI',
      },
      {} as any,
    )) as { exitCode: number; stderr: string };

    assert.notStrictEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /direct database querying through bash is blocked/i,
    );
    assert.match(result.stderr, /sql validate/i);
    assert.match(result.stderr, /sql run/i);
  });

  it('blocks raw SQL command via tool path', async () => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const execute = tools.bash.execute!;
    const result = (await execute(
      {
        command: 'SELECT 1',
        reasoning: 'Try raw SQL directly',
      },
      {} as any,
    )) as { exitCode: number; stderr: string };

    assert.notStrictEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /direct database querying through bash is blocked/i,
    );
    assert.match(result.stderr, /sql validate/i);
    assert.match(result.stderr, /sql run/i);
  });

  it('blocks invalid sql subcommand via tool path', async () => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const execute = tools.bash.execute!;
    const result = (await execute(
      {
        command: 'sql explain "SELECT 1"',
        reasoning: 'Try unsupported sql subcommand',
      },
      {} as any,
    )) as { exitCode: number; stderr: string };

    assert.notStrictEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /direct database querying through bash is blocked/i,
    );
    assert.match(result.stderr, /sql validate/i);
    assert.match(result.stderr, /sql run/i);
  });

  it('blocks direct DB CLI via sandbox path', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand('sqlite3 app.db "SELECT 1"');
    assert.notStrictEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /direct database querying through bash is blocked/i,
    );
    assert.match(result.stderr, /sql validate/i);
    assert.match(result.stderr, /sql run/i);
  });

  it('allows sql validate/run but blocks compound command containing direct DB CLI', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const validResult = await sandbox.executeCommand('sql validate "SELECT 1"');
    assert.strictEqual(validResult.exitCode, 0);

    const runResult = await sandbox.executeCommand(
      'sql run "SELECT 1 as value"',
    );
    assert.strictEqual(runResult.exitCode, 0);

    const blockedCompound = await sandbox.executeCommand(
      'echo ok && psql -c "SELECT 1"',
    );
    assert.notStrictEqual(blockedCompound.exitCode, 0);
    assert.match(
      blockedCompound.stderr,
      /direct database querying through bash is blocked/i,
    );
    assert.match(blockedCompound.stderr, /sql validate/i);
    assert.match(blockedCompound.stderr, /sql run/i);
  });

  it('blocks direct DB CLI in command substitution', async () => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const execute = tools.bash.execute!;
    const result = (await execute(
      {
        command: 'echo $(psql -c "SELECT 1")',
        reasoning: 'Try command substitution bypass',
      },
      {} as any,
    )) as { exitCode: number; stderr: string };

    assert.notStrictEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /direct database querying through bash is blocked/i,
    );
  });

  it('does not block non-invoked function definitions', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand(
      'f(){ psql -c "SELECT 1"; }; echo ok',
    );

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /ok/);
  });

  it('blocks invoked functions that run direct DB CLI', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand(
      'f(){ psql -c "SELECT 1"; }; f',
    );

    assert.notStrictEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /direct database querying through bash is blocked/i,
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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand(
      'cd /skills/skills && cat my-skill/SKILL.md',
    );

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('# My Skill Content'));
  });

  it('handles absolute paths to skill files', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
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
      skillMounts: [
        fakeSkillMount(skillsDir1, '/skills/skills-a'),
        fakeSkillMount(skillsDir2, '/skills/skills-b'),
      ],
      filesystem: new InMemoryFs(),
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
      skillMounts: [
        fakeSkillMount(skillsDir1, '/skills/skills-a'),
        fakeSkillMount(skillsDir2, '/skills/skills-b'),
      ],
      filesystem: new InMemoryFs(),
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

  it('sql run writes results and returns /sql path', async () => {
    const { adapter } = await init_db('');

    const { sandbox } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand('sql run "SELECT 1 as test"');

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('/sql/'), 'Should output path in /sql');
    assert.ok(result.stdout.includes('rows:'), 'Should show row count');
  });

  it('sql run results are readable via returned path', async () => {
    const { adapter } = await init_db('');

    const { sandbox } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const sqlResult = await sandbox.executeCommand(
      'sql run "SELECT 42 as value"',
    );
    assert.strictEqual(sqlResult.exitCode, 0);

    const firstLine = sqlResult.stdout.split('\n')[0].trim();
    const filePath = firstLine.replace('results stored in ', '');
    assert.ok(filePath.startsWith('/sql/'), 'Path should be in /sql');

    const catResult = await sandbox.executeCommand(`cat ${filePath}`);
    assert.strictEqual(catResult.exitCode, 0);
    assert.ok(catResult.stdout.includes('42'));
  });

  it('sql run results are accessible across turns via /artifacts', async () => {
    const { adapter } = await init_db('');

    // Shared artifacts filesystem (simulates chat-level storage)
    const sharedArtifactsFs = new InMemoryFs();

    // Turn 1: Execute SQL and get path
    const { sandbox: sandbox1 } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs, // Shared artifacts
    });

    const sqlResult = await sandbox1.executeCommand(
      'sql run "SELECT \'Test\' as name"',
    );
    assert.strictEqual(sqlResult.exitCode, 0);
    const firstLine = sqlResult.stdout.split('\n')[0].trim();
    const filePath = firstLine.replace('results stored in ', '');

    // Turn 2: New sandbox with same artifactsFilesystem
    const { sandbox: sandbox2 } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs, // Same shared artifacts
    });

    // Should be able to read file from turn 1 using the same path
    const catResult = await sandbox2.executeCommand(`cat ${filePath}`);
    assert.strictEqual(
      catResult.exitCode,
      0,
      `Should access turn-1 result from turn-2. stderr: ${catResult.stderr}`,
    );
    assert.ok(catResult.stdout.includes('Test'));
  });

  it('sql validate returns valid for SELECT', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await sandbox.executeCommand('sql validate "SELECT 1"');

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('valid'));
  });

  it('sql validate rejects non-SELECT queries', async () => {
    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
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
    const { adapter } = await init_db('');

    const { sandbox } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    // Query a non-existent table to trigger an error
    const result = await sandbox.executeCommand(
      'sql run "SELECT * FROM nonexistent_table_xyz"',
    );

    assert.notStrictEqual(result.exitCode, 0);
    assert.ok(result.stderr.length > 0, 'Should have error message');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL Meta via toModelOutput
// Tests that formatted SQL is exposed in meta but stripped from model context
// ─────────────────────────────────────────────────────────────────────────────

describe('sql meta via toModelOutput', () => {
  const testUsage = {
    inputTokens: {
      total: 3,
      noCache: 3,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 10,
      text: 10,
      reasoning: undefined,
    },
  } as const;

  const createBashToolCallModel = (input: string) =>
    new MockLanguageModelV3({
      doGenerate: {
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: testUsage,
        warnings: [],
        content: [
          {
            type: 'tool-call',
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: 'bash',
            input,
          },
        ],
      },
    });

  const runBashToolCall = async (input: string) => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const result = await generateText({
      model: createBashToolCallModel(input),
      prompt: 'test-input',
      stopWhen: stepCountIs(1),
      tools: { bash: tools.bash },
    });

    return result.content as Array<{
      type: string;
      toolName?: string;
      output?: Record<string, unknown>;
    }>;
  };

  it('sql run includes formattedSql in meta', async () => {
    const content = await runBashToolCall(
      `{"command":"sql run \\"SELECT 1 as test\\"","reasoning":"test meta"}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
    assert.ok(toolResult.output?.meta, 'Expected meta on output');
    assert.ok(
      (toolResult.output.meta as Record<string, unknown>).formattedSql,
      'Expected formattedSql in meta',
    );
  });

  it('sql validate includes formattedSql in meta', async () => {
    const content = await runBashToolCall(
      `{"command":"sql validate \\"SELECT 1 as test\\"","reasoning":"test meta"}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
    assert.ok(toolResult.output?.meta, 'Expected meta on output');
    assert.ok(
      (toolResult.output.meta as Record<string, unknown>).formattedSql,
      'Expected formattedSql in meta',
    );
  });

  it('non-sql commands have no meta', async () => {
    const content = await runBashToolCall(
      `{"command":"echo hello","reasoning":"test no meta"}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
    assert.strictEqual(
      toolResult.output?.meta,
      undefined,
      'Non-SQL commands should not have meta',
    );
  });

  it('sql run error still includes formattedSql in meta', async () => {
    const content = await runBashToolCall(
      `{"command":"sql run \\"SELECT * FROM nonexistent_xyz\\"","reasoning":"test error meta"}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool result');
    assert.ok(toolResult.output?.meta, 'Expected meta even on error');
    assert.ok(
      (toolResult.output.meta as Record<string, unknown>).formattedSql,
      'Expected formattedSql in meta even on execution error',
    );
  });

  it('toModelOutput strips meta from model context', async () => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const bash = tools.bash as any;
    assert.ok(bash.toModelOutput, 'bash tool should have toModelOutput');

    const mockOutput = {
      stdout: 'results stored in /sql/test.json\ncolumns: test\nrows: 1\n',
      stderr: '',
      exitCode: 0,
      meta: { formattedSql: 'SELECT\n  1 AS test' },
    };

    const modelOutput = await bash.toModelOutput({
      toolCallId: 'test',
      input: { command: 'sql run "SELECT 1 as test"', reasoning: 'test' },
      output: mockOutput,
    });

    assert.strictEqual(modelOutput.type, 'json');
    assert.strictEqual(
      (modelOutput.value as Record<string, unknown>).meta,
      undefined,
      'meta should be stripped from model output',
    );
    assert.strictEqual(
      (modelOutput.value as Record<string, unknown>).stdout,
      mockOutput.stdout,
      'stdout should be preserved in model output',
    );
  });

  it('parallel bash calls get isolated meta via AsyncLocalStorage', async () => {
    const { tools } = await createResultTools({
      adapter: (
        await init_db('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
      ).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const execute = tools.bash.execute!;

    const [sqlRun, sqlValidate, echo] = await Promise.all([
      execute(
        { command: 'sql run "SELECT 1 as a"', reasoning: 'test parallel 1' },
        {} as any,
      ),
      execute(
        {
          command: 'sql validate "SELECT name FROM users"',
          reasoning: 'test parallel 2',
        },
        {} as any,
      ),
      execute(
        { command: 'echo hello', reasoning: 'test parallel 3' },
        {} as any,
      ),
    ]);

    const sqlRunResult = sqlRun as Record<string, unknown>;
    const sqlValidateResult = sqlValidate as Record<string, unknown>;
    const echoResult = echo as Record<string, unknown>;

    assert.ok(sqlRunResult.meta, 'sql run should have meta');
    assert.ok(
      (
        (sqlRunResult.meta as Record<string, unknown>).formattedSql as string
      ).includes('SELECT'),
      'sql run meta should contain SELECT',
    );

    assert.ok(sqlValidateResult.meta, 'sql validate should have meta');
    assert.ok(
      (
        (sqlValidateResult.meta as Record<string, unknown>)
          .formattedSql as string
      ).includes('users'),
      'sql validate meta should reference users table',
    );

    assert.strictEqual(echoResult.meta, undefined, 'echo should have no meta');
  });

  it('sql run with WITH clause includes formattedSql in meta', async () => {
    const content = await runBashToolCall(
      `{"command":"sql run \\"WITH cte AS (SELECT 1 as v) SELECT v FROM cte\\"","reasoning":"test WITH"}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool call to succeed');
    assert.ok(toolResult.output?.meta, 'Expected meta on output');
    const formattedSql = (toolResult.output.meta as Record<string, unknown>)
      .formattedSql as string;
    assert.ok(
      formattedSql.includes('WITH'),
      'formattedSql should contain WITH',
    );
    assert.ok(
      formattedSql.includes('cte'),
      'formattedSql should contain CTE alias',
    );
  });

  it('compound sql commands produce meta from last command', async () => {
    const { tools } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new InMemoryFs(),
    });

    const execute = tools.bash.execute!;
    const result = (await execute(
      {
        command: 'sql run "SELECT 1 as first" && sql run "SELECT 2 as second"',
        reasoning: 'test compound',
      },
      {} as any,
    )) as Record<string, unknown>;

    assert.ok(result.meta, 'compound sql should have meta');
    const formattedSql = (result.meta as Record<string, unknown>)
      .formattedSql as string;
    assert.ok(
      formattedSql.includes('second'),
      'meta should reflect last sql command',
    );
  });

  it('sql validate with syntax error still includes formattedSql in meta', async () => {
    const content = await runBashToolCall(
      `{"command":"sql validate \\"SELECT * FORM users\\"","reasoning":"test syntax error"}`,
    );

    const toolResult = content.find(
      (part) => part.type === 'tool-result' && part.toolName === 'bash',
    );
    assert.ok(toolResult, 'Expected bash tool result');
    assert.ok(toolResult.output?.meta, 'Expected meta even on syntax error');
    assert.ok(
      (toolResult.output.meta as Record<string, unknown>).formattedSql,
      'Expected formattedSql in meta even on syntax error',
    );
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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
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
      skillMounts: [fakeSkillMount(skillsDir)],
      filesystem: new InMemoryFs(),
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
// Tests for files being written to the real filesystem using ReadWriteFs
// ─────────────────────────────────────────────────────────────────────────────

describe('artifacts persistence to disk', () => {
  let persistDir: string;

  beforeEach(async () => {
    persistDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'result-tools-persist-'),
    );
  });

  afterEach(async () => {
    await fs.rm(persistDir, { recursive: true, force: true });
  });

  it('files written via sandbox appear on real filesystem (scoped by chatId)', async () => {
    const dataDir = path.join(persistDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });

    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: new ReadWriteFs({ root: dataDir }),
    });

    await sandbox.executeCommand(
      'mkdir -p /mydata && echo "persisted content" > /mydata/test.txt',
    );

    const realPath = path.join(dataDir, 'mydata', 'test.txt');
    const content = await fs.readFile(realPath, 'utf-8');
    assert.ok(content.includes('persisted content'));
  });

  it('results from previous turns are accessible in /artifacts via shared filesystem', async () => {
    // Shared artifacts filesystem (simulates chat-level storage)
    const sharedArtifactsFs = new InMemoryFs();

    // First turn - write to results (also goes to shared artifacts)
    const { sandbox: sandbox1 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs, // Shared artifacts
    });
    await sandbox1.executeCommand('echo "turn 1 data" > /artifacts/turn1.txt');

    // Second turn - should see first turn's results in shared artifacts
    const { sandbox: sandbox2 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs, // Same shared artifacts
    });

    // Read previous turn's artifact
    const catResult = await sandbox2.executeCommand('cat /artifacts/turn1.txt');
    assert.strictEqual(catResult.exitCode, 0, `stderr: ${catResult.stderr}`);
    assert.ok(catResult.stdout.includes('turn 1 data'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unmounted Path Isolation
// Tests for shared writes across turns via artifactsFilesystem
// ─────────────────────────────────────────────────────────────────────────────

describe('unmounted path isolation with chat-level reads', () => {
  it('writes to unmounted paths are visible from chat-level in next turn', async () => {
    const sharedArtifactsFs = new InMemoryFs();

    // Turn 1: write to /mydata (unmounted path)
    const { sandbox: sandbox1 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs,
    });

    await sandbox1.executeCommand('mkdir -p /mydata');
    await sandbox1.executeCommand('echo "turn1" > /mydata/test.txt');

    // Verify write succeeded in turn 1
    const readTurn1 = await sandbox1.executeCommand('cat /mydata/test.txt');
    assert.strictEqual(
      readTurn1.exitCode,
      0,
      `read in turn1 failed: ${readTurn1.stderr}`,
    );

    // Turn 2: can READ turn 1's file (from chat-level)
    const { sandbox: sandbox2 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs,
    });

    const read = await sandbox2.executeCommand('cat /mydata/test.txt');
    assert.strictEqual(
      read.exitCode,
      0,
      `Turn 2 should read from chat-level. stderr: ${read.stderr}`,
    );
    assert.ok(
      read.stdout.includes('turn1'),
      'Turn 2 should read content from chat-level',
    );
  });

  it('latest write to unmounted path wins in chat-level (flat paths)', async () => {
    const sharedArtifactsFs = new InMemoryFs();

    // Turn 1: write to /tmp/file.txt
    const { sandbox: sandbox1 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs,
    });
    await sandbox1.executeCommand(
      'mkdir -p /tmp && echo "version1" > /tmp/file.txt',
    );

    // Turn 2: overwrite /tmp/file.txt (directory already exists in chat-level)
    const { sandbox: sandbox2 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs,
    });
    await sandbox2.executeCommand(
      'mkdir -p /tmp && echo "version2" > /tmp/file.txt',
    );

    // Turn 3: should see version2 (latest wins)
    const { sandbox: sandbox3 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs,
    });

    const read = await sandbox3.executeCommand('cat /tmp/file.txt');
    assert.strictEqual(read.exitCode, 0);
    assert.ok(read.stdout.includes('version2'), 'Should see latest version');
    assert.ok(!read.stdout.includes('version1'), 'Should not see old version');
  });

  it('unmounted subdirectories work correctly', async () => {
    const sharedArtifactsFs = new InMemoryFs();

    // Turn 1: create nested directory and file
    const { sandbox: sandbox1 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs,
    });
    await sandbox1.executeCommand(
      'mkdir -p /data && echo "nested" > /data/file.txt',
    );

    // Turn 2: can read the nested file
    const { sandbox: sandbox2 } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedArtifactsFs,
    });

    const read = await sandbox2.executeCommand('cat /data/file.txt');
    assert.strictEqual(read.exitCode, 0, `stderr: ${read.stderr}`);
    assert.ok(read.stdout.includes('nested'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Markdown Report Generation (Replicating Agent File Storage Issue)
// Tests for creating markdown reports from SQL results using bash commands
// ─────────────────────────────────────────────────────────────────────────────

describe('markdown report generation from sql results', () => {
  it('can create markdown report from sql json output using sequential writes', async () => {
    const { adapter } = await init_db('');
    const sharedFs = new InMemoryFs();

    const { sandbox } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: sharedFs,
    });

    const sqlResult = await sandbox.executeCommand(
      'sql run "SELECT 1 as store_id, 100 as rentals_2022"',
    );
    assert.strictEqual(
      sqlResult.exitCode,
      0,
      `sql run failed: ${sqlResult.stderr}`,
    );

    const firstLine = sqlResult.stdout.split('\n')[0].trim();
    const sqlFilePath = firstLine.replace('results stored in ', '');
    assert.ok(
      sqlFilePath.startsWith('/sql/'),
      `Expected /sql/ path, got: ${sqlFilePath}`,
    );

    await sandbox.executeCommand(
      'echo "# Rentals per Store for 2022" > /report.md',
    );
    await sandbox.executeCommand('echo "" >> /report.md');
    await sandbox.executeCommand('echo "| Store ID | Rentals |" >> /report.md');
    await sandbox.executeCommand('echo "|----------|---------|" >> /report.md');
    const jqCmd = `cat ${sqlFilePath} | jq -r '.[] | "| \\(.store_id) | \\(.rentals_2022) |"' >> /report.md`;
    await sandbox.executeCommand(jqCmd);

    const catResult = await sandbox.executeCommand('cat /report.md');
    assert.strictEqual(
      catResult.exitCode,
      0,
      `cat /report.md failed: ${catResult.stderr}`,
    );
    assert.ok(
      catResult.stdout.includes('# Rentals per Store for 2022'),
      'Should have title',
    );
    assert.ok(
      catResult.stdout.includes('| Store ID | Rentals |'),
      'Should have table header',
    );
  });

  it('file persists across turns when using shared filesystem', async () => {
    const { adapter } = await init_db('');
    const sharedFs = new InMemoryFs();

    // Turn 1: Create report
    const { sandbox: sandbox1 } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: sharedFs,
    });

    const sqlResult = await sandbox1.executeCommand(
      'sql run "SELECT 42 as value"',
    );
    assert.strictEqual(sqlResult.exitCode, 0);

    const writeResult = await sandbox1.executeCommand(
      'echo "# My Report" > /report.md',
    );
    assert.strictEqual(
      writeResult.exitCode,
      0,
      `Write failed: ${writeResult.stderr}`,
    );

    // Turn 2: Read report from new sandbox
    const { sandbox: sandbox2 } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: sharedFs,
    });

    const readResult = await sandbox2.executeCommand('cat /report.md');
    assert.strictEqual(
      readResult.exitCode,
      0,
      `Read failed in turn 2: ${readResult.stderr}`,
    );
    assert.ok(readResult.stdout.includes('# My Report'));
  });

  it('jq command processes json correctly', async () => {
    const sharedFs = new InMemoryFs();

    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedFs,
    });

    // Write JSON file manually
    await sandbox.executeCommand(
      'mkdir -p /sql && echo \'[{"id": 1, "name": "test"}]\' > /sql/data.json',
    );

    // Test jq processing
    const jqResult = await sandbox.executeCommand(
      'cat /sql/data.json | jq -r \'.[] | "ID: \\(.id), Name: \\(.name)"\'',
    );
    assert.strictEqual(jqResult.exitCode, 0, `jq failed: ${jqResult.stderr}`);
    assert.ok(
      jqResult.stdout.includes('ID: 1'),
      `Expected "ID: 1" in output, got: ${jqResult.stdout}`,
    );
  });

  it('sequential writes create multi-line file', async () => {
    const sharedFs = new InMemoryFs();

    const { sandbox } = await createResultTools({
      adapter: (await init_db('')).adapter,
      skillMounts: [],
      filesystem: sharedFs,
    });

    const cmd =
      'echo "Line 1" > /output.md && echo "Line 2" >> /output.md && echo "Line 3" >> /output.md';
    const result = await sandbox.executeCommand(cmd);
    assert.strictEqual(
      result.exitCode,
      0,
      `Sequential writes failed: ${result.stderr}`,
    );

    const catResult = await sandbox.executeCommand('cat /output.md');
    assert.strictEqual(
      catResult.exitCode,
      0,
      `cat failed: ${catResult.stderr}`,
    );
    assert.ok(catResult.stdout.includes('Line 1'), 'Should have Line 1');
    assert.ok(catResult.stdout.includes('Line 2'), 'Should have Line 2');
    assert.ok(catResult.stdout.includes('Line 3'), 'Should have Line 3');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TrackedFs Concurrency
// Tests for concurrent chat sessions with separate TrackedFs instances
// ─────────────────────────────────────────────────────────────────────────────

describe('TrackedFs concurrency', () => {
  it('concurrent chats with separate TrackedFs instances track files independently', async () => {
    const { adapter } = await init_db('');
    const sharedFs = new InMemoryFs();

    const trackedFs1 = new TrackedFs(sharedFs);
    const trackedFs2 = new TrackedFs(sharedFs);

    const { sandbox: sandbox1 } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: trackedFs1,
    });

    const { sandbox: sandbox2 } = await createResultTools({
      adapter,
      skillMounts: [],
      filesystem: trackedFs2,
    });

    await Promise.all([
      sandbox1.executeCommand(
        'mkdir -p /sql && echo "chat1" > /sql/chat1.json',
      ),
      sandbox2.executeCommand(
        'mkdir -p /sql && echo "chat2" > /sql/chat2.json',
      ),
    ]);

    const files1 = trackedFs1.getCreatedFiles();
    const files2 = trackedFs2.getCreatedFiles();

    assert.ok(
      files1.includes('/sql/chat1.json'),
      'TrackedFs1 should track chat1.json',
    );
    assert.ok(
      !files1.includes('/sql/chat2.json'),
      'TrackedFs1 should NOT track chat2.json',
    );

    assert.ok(
      files2.includes('/sql/chat2.json'),
      'TrackedFs2 should track chat2.json',
    );
    assert.ok(
      !files2.includes('/sql/chat1.json'),
      'TrackedFs2 should NOT track chat1.json',
    );
  });
});
