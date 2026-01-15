import { Bash, ReadWriteFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createBinaryBridges } from '../src/lib/sandbox/binary-bridges.ts';

/**
 * Comprehensive test suite for binary bridges.
 *
 * These tests prevent regression of the three critical issues we fixed:
 * 1. Virtual CWD → Real CWD: ctx.cwd like /home/user must resolve to real path
 * 2. Virtual PATH → Real PATH: ctx.env.PATH must not override process.env.PATH
 * 3. Cross-platform path detection: paths must be detected on both Unix and Windows
 */

describe('createBinaryBridges', () => {
  describe('input normalization', () => {
    it('accepts string input (name === binaryPath)', () => {
      const bridges = createBinaryBridges('echo');
      assert.strictEqual(bridges.length, 1);
      assert.strictEqual(bridges[0].name, 'echo');
    });

    it('accepts config object with name only', () => {
      const bridges = createBinaryBridges({ name: 'echo' });
      assert.strictEqual(bridges.length, 1);
      assert.strictEqual(bridges[0].name, 'echo');
    });

    it('accepts config object with name and binaryPath', () => {
      const bridges = createBinaryBridges({
        name: 'python',
        binaryPath: 'python3',
      });
      assert.strictEqual(bridges.length, 1);
      assert.strictEqual(bridges[0].name, 'python');
    });

    it('accepts config object with allowedArgs regex', () => {
      const bridges = createBinaryBridges({
        name: 'git',
        allowedArgs: /^(status|log|diff)/,
      });
      assert.strictEqual(bridges.length, 1);
      assert.strictEqual(bridges[0].name, 'git');
    });

    it('accepts mixed string and config inputs', () => {
      const bridges = createBinaryBridges(
        'echo',
        { name: 'python', binaryPath: 'python3' },
        'node',
      );
      assert.strictEqual(bridges.length, 3);
      assert.strictEqual(bridges[0].name, 'echo');
      assert.strictEqual(bridges[1].name, 'python');
      assert.strictEqual(bridges[2].name, 'node');
    });

    it('returns array of CustomCommand objects with execute function', () => {
      const bridges = createBinaryBridges('echo');
      const cmd = bridges[0];
      assert.ok(cmd);
      assert.strictEqual(typeof cmd.name, 'string');
      assert.strictEqual('load' in cmd, false);
      assert.strictEqual('execute' in cmd, true);
      if ('execute' in cmd) {
        assert.strictEqual(typeof cmd.execute, 'function');
      }
    });
  });

  describe('argument validation (allowedArgs)', async () => {
    it('allows args matching the regex', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges({
          name: 'echo',
          allowedArgs: /^(hello|world)$/,
        }),
      });

      const result = await bash.exec('echo hello world');
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /hello.*world/);
    });

    it('rejects args not matching the regex', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges({
          name: 'echo',
          allowedArgs: /^(hello|world)$/,
        }),
      });

      const result = await bash.exec('echo forbidden');
      assert.strictEqual(result.exitCode, 1);
    });

    it('returns exitCode 1 for rejected args', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges({
          name: 'echo',
          allowedArgs: /^safe$/,
        }),
      });

      const result = await bash.exec('echo unsafe');
      assert.strictEqual(result.exitCode, 1);
    });

    it('includes descriptive error in stderr for rejected args', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges({
          name: 'echo',
          allowedArgs: /^safe$/,
        }),
      });

      const result = await bash.exec('echo unsafe');
      assert.match(result.stderr, /not allowed by security policy/);
      assert.match(result.stderr, /unsafe/);
    });
  });
});

describe('path argument detection', () => {
  // Helper to run command and check if path was resolved
  async function testPathDetection(arg: string, shouldResolve: boolean) {
    const bash = new Bash({
      fs: new ReadWriteFs({ root: process.cwd() }),
      customCommands: createBinaryBridges('echo'),
    });

    // Echo just returns args, so we can check what was passed
    const result = await bash.exec(`echo ${arg}`);

    if (shouldResolve) {
      // If path was resolved, it should be an absolute path
      assert.ok(
        result.stdout.startsWith('/') || result.stdout.match(/^[A-Z]:\\/),
        `Expected '${arg}' to be resolved to absolute path, got: ${result.stdout}`,
      );
    } else {
      // If not resolved, should be passed through as-is
      assert.strictEqual(result.stdout.trim(), arg);
    }
  }

  describe('file extensions', () => {
    it('detects .md files as paths', async () => {
      await testPathDetection('slides.md', true);
    });

    it('detects .ts files as paths', async () => {
      await testPathDetection('index.ts', true);
    });

    it('detects .json files as paths', async () => {
      await testPathDetection('package.json', true);
    });

    it('ignores extensionless words like "status"', async () => {
      await testPathDetection('status', false);
    });

    it('ignores words like "hello"', async () => {
      await testPathDetection('hello', false);
    });
  });

  describe('path separators (cross-platform)', () => {
    it('detects forward slash paths (src/file)', async () => {
      await testPathDetection('src/index', true);
    });

    it('detects paths with multiple segments', async () => {
      await testPathDetection('packages/context/src', true);
    });
  });

  describe('relative paths', () => {
    it('detects ./ prefixed paths', async () => {
      await testPathDetection('./file', true);
    });

    it('detects ../ prefixed paths', async () => {
      await testPathDetection('../file', true);
    });

    it('detects single dot (.)', async () => {
      await testPathDetection('.', true);
    });

    it('detects double dot (..)', async () => {
      await testPathDetection('..', true);
    });
  });

  describe('flags and options', () => {
    it('passes through flags starting with -', async () => {
      await testPathDetection('-v', false);
    });

    it('passes through flags starting with --', async () => {
      await testPathDetection('--version', false);
    });

    it('passes through combined flags', async () => {
      await testPathDetection('-rf', false);
    });
  });
});

describe('binary bridges integration', () => {
  describe('PATH environment (CRITICAL REGRESSION TEST)', () => {
    it('uses process.env.PATH, not ctx.env.PATH', async () => {
      // This is the critical test - just-bash sets ctx.env.PATH to /bin:/usr/bin
      // which doesn't include /opt/homebrew/bin, /usr/local/bin, nvm paths, etc.
      // The binary bridge MUST use process.env.PATH to find binaries
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges('node'),
      });

      // If PATH was overridden by ctx.env.PATH (/bin:/usr/bin), this would fail
      // because node is typically in /usr/local/bin, nvm path, or similar
      const result = await bash.exec('node --version');
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /^v\d+\.\d+\.\d+/);
    });

    it('node --version returns actual node version', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges('node'),
      });

      const result = await bash.exec('node --version');
      assert.strictEqual(result.exitCode, 0);

      // Should match the actual running node version
      const expectedVersion = process.version;
      assert.strictEqual(result.stdout.trim(), expectedVersion);
    });
  });

  describe('CWD resolution (CRITICAL REGRESSION TEST)', () => {
    it('resolves virtual cwd to real filesystem path', async () => {
      // ReadWriteFs mounts at process.cwd(), virtual cwd starts at /
      // When we run a command, it should execute in process.cwd(), not /home/user
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges('node'),
      });

      // node --version works, proving cwd is valid (not /home/user which doesn't exist)
      // If cwd was left as virtual /home/user, node would fail to start
      const result = await bash.exec('node --version');
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /^v\d+/);
    });

    it('file arguments are resolved relative to real cwd', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges('echo'),
      });

      // package.json should resolve to {process.cwd()}/package.json
      const result = await bash.exec('echo package.json');
      assert.strictEqual(result.exitCode, 0);
      // The path should be absolute (resolved)
      assert.match(result.stdout, new RegExp(`${process.cwd()}/package.json`));
    });
  });

  describe('end-to-end execution', () => {
    it('executes echo command and returns output', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges('echo'),
      });

      const result = await bash.exec('echo "hello world"');
      assert.strictEqual(result.exitCode, 0);
      assert.match(result.stdout, /hello world/);
    });

    it('handles non-zero exit codes', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        // Use a custom command that simulates exit code
        customCommands: createBinaryBridges({
          name: 'falsecmd',
          binaryPath: 'false', // 'false' command always exits with 1
        }),
      });

      const result = await bash.exec('falsecmd');
      assert.strictEqual(result.exitCode, 1);
    });

    it('returns stderr on error', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges('node'),
      });

      // Use a file that doesn't exist to trigger an error
      const result = await bash.exec('node nonexistent_file_12345.js');
      // Node outputs error to stderr when file not found
      assert.ok(result.stderr.length > 0 || result.exitCode !== 0);
    });

    it('handles binary not found (exitCode 127)', async () => {
      const bash = new Bash({
        fs: new ReadWriteFs({ root: process.cwd() }),
        customCommands: createBinaryBridges('nonexistent_binary_xyz123'),
      });

      const result = await bash.exec('nonexistent_binary_xyz123');
      assert.strictEqual(result.exitCode, 127);
    });
  });
});

describe('error handling', () => {
  it('returns exitCode 127 for missing binary', async () => {
    const bash = new Bash({
      fs: new ReadWriteFs({ root: process.cwd() }),
      customCommands: createBinaryBridges('this_binary_does_not_exist_xyz'),
    });

    const result = await bash.exec('this_binary_does_not_exist_xyz');
    assert.strictEqual(result.exitCode, 127);
  });

  it('preserves stderr on non-zero exit', async () => {
    const bash = new Bash({
      fs: new ReadWriteFs({ root: process.cwd() }),
      customCommands: createBinaryBridges('node'),
    });

    // Run node with a file that doesn't exist - produces stderr
    const result = await bash.exec('node nonexistent_file_xyz.js');
    assert.ok(result.exitCode !== 0);
    assert.ok(result.stderr.length > 0, 'stderr should not be empty');
  });

  it('includes binary name in error message for missing binary', async () => {
    const bash = new Bash({
      fs: new ReadWriteFs({ root: process.cwd() }),
      customCommands: createBinaryBridges('missing_cmd_xyz'),
    });

    const result = await bash.exec('missing_cmd_xyz arg1 arg2');
    assert.match(result.stderr, /missing_cmd_xyz/);
  });
});
