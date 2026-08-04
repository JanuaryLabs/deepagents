import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  DAYTONA_DEFAULT_DESTINATION,
  type DisposableSandbox,
  createBashTool,
  createDaytonaSandbox,
} from '@deepagents/context';

type DaytonaClient = Parameters<typeof createDaytonaSandbox>[0];

interface LiveSandbox {
  client: DaytonaClient;
  name: string;
  sandbox: DisposableSandbox;
}

const LITERAL_LINE = "line one's $HOME `whoami`";

async function isDaytonaSdkAvailable(): Promise<boolean> {
  try {
    await import('@daytona/sdk');
    return true;
  } catch {
    return false;
  }
}

async function createLiveSandbox(): Promise<LiveSandbox> {
  const { Daytona } = await import('@daytona/sdk');
  const client = new Daytona();
  const name = `deepagents-bash-contract-${randomUUID()}`;
  try {
    const sandbox = await createDaytonaSandbox(client, { name });
    return { client, name, sandbox };
  } catch (error) {
    await deleteByName(client, name);
    throw error;
  }
}

async function disposeLiveSandbox(live: LiveSandbox): Promise<void> {
  await live.sandbox.dispose();
  await deleteByName(live.client, live.name);
}

async function deleteByName(
  client: DaytonaClient,
  name: string,
): Promise<void> {
  const sandbox = await client.get(name).catch(() => undefined);
  await sandbox?.delete?.();
}

async function readAllText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function readFirstChunk(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  try {
    const { value, done } = await reader.read();
    assert.ok(!done && value, 'stream closed without a chunk');
    return new TextDecoder().decode(value);
  } finally {
    reader.releaseLock();
  }
}

function literalHeredoc(exitCode?: number): string {
  return [
    "cat <<'DEEPAGENTS_PAYLOAD'",
    LITERAL_LINE,
    'DEEPAGENTS_PAYLOAD',
    ...(exitCode === undefined ? [] : [`exit ${exitCode}`]),
  ].join('\n');
}

const sdkAvailable = await isDaytonaSdkAvailable();
const apiKeyAvailable = Boolean(process.env.DAYTONA_API_KEY);
const liveAvailable = sdkAvailable && apiKeyAvailable;

if (!apiKeyAvailable) {
  console.log('Skipping Daytona Bash contract tests: DAYTONA_API_KEY not set');
} else if (!sdkAvailable) {
  console.log(
    'Skipping Daytona Bash contract tests: @daytona/sdk not installed',
  );
}

describe('Daytona Bash contract (live)', { skip: !liveAvailable }, () => {
  it('preserves Bash arrays through createBashTool', async () => {
    // Arrange
    let live: LiveSandbox | undefined;
    try {
      live = await createLiveSandbox();
      const mkdir = await live.sandbox.executeCommand(
        `mkdir -p ${DAYTONA_DEFAULT_DESTINATION}`,
      );
      assert.strictEqual(mkdir.exitCode, 0);
      const { bash } = await createBashTool({
        sandbox: live.sandbox,
        destination: DAYTONA_DEFAULT_DESTINATION,
        promptOptions: { toolPrompt: '' },
      });
      const execute = bash.execute;
      assert.ok(execute);

      // Act
      const result = await execute(
        {
          command:
            'values=(one "two three"); printf \'<%s>\\n\' "${values[1]}"',
          reasoning: 'verify Daytona preserves Bash array syntax',
        },
        {
          abortSignal: undefined,
          context: {},
          messages: [],
          toolCallId: 'daytona-bash-array-contract',
        },
      );

      // Assert
      assert.deepStrictEqual(result, {
        stdout: '<two three>\n',
        stderr: '',
        exitCode: 0,
      });
    } finally {
      if (live) await disposeLiveSandbox(live);
    }
  });

  it('preserves literal heredoc content through executeCommand', async () => {
    // Arrange
    let live: LiveSandbox | undefined;
    try {
      live = await createLiveSandbox();

      // Act
      const result = await live.sandbox.executeCommand(literalHeredoc());

      // Assert
      assert.deepStrictEqual(result, {
        stdout: `${LITERAL_LINE}\n`,
        stderr: '',
        exitCode: 0,
      });
    } finally {
      if (live) await disposeLiveSandbox(live);
    }
  });

  it('preserves a deliberate non-zero exit after complex quoting', async () => {
    // Arrange
    let live: LiveSandbox | undefined;
    try {
      live = await createLiveSandbox();

      // Act
      const result = await live.sandbox.executeCommand(literalHeredoc(37));

      // Assert
      assert.strictEqual(result.stdout, `${LITERAL_LINE}\n`);
      assert.strictEqual(result.exitCode, 37);
    } finally {
      if (live) await disposeLiveSandbox(live);
    }
  });

  it('preserves complex command text and exit code through spawn', async () => {
    // Arrange
    let live: LiveSandbox | undefined;
    try {
      live = await createLiveSandbox();
      const spawn = live.sandbox.spawn;
      assert.ok(spawn);

      // Act
      const child = spawn(literalHeredoc(43));
      const [stdout, stderr, exit] = await Promise.all([
        readAllText(child.stdout),
        readAllText(child.stderr),
        child.exit,
      ]);

      // Assert
      assert.strictEqual(stdout, `${LITERAL_LINE}\n`);
      assert.strictEqual(stderr, '');
      assert.deepStrictEqual(exit, {
        code: 43,
        signal: null,
        success: false,
      });
    } finally {
      if (live) await disposeLiveSandbox(live);
    }
  });

  it('preserves tricky env values and cwd through spawn', async () => {
    // Arrange
    let live: LiveSandbox | undefined;
    try {
      live = await createLiveSandbox();
      const cwd = "/tmp/daytona cwd one's $HOME `whoami`";
      const envValue = "env value one's $HOME `whoami` with spaces";
      const createCwd = await live.sandbox.executeCommand(
        [
          "cwd=$(cat <<'DEEPAGENTS_CWD'",
          cwd,
          'DEEPAGENTS_CWD',
          ')',
          'mkdir -p -- "$cwd"',
        ].join('\n'),
      );
      assert.strictEqual(createCwd.exitCode, 0, createCwd.stderr);
      const spawn = live.sandbox.spawn;
      assert.ok(spawn);

      // Act
      const child = spawn('printf \'<%s>\\n<%s>\\n\' "$TRICKY_VALUE" "$PWD"', {
        cwd,
        env: { TRICKY_VALUE: envValue },
      });
      const [stdout, stderr, exit] = await Promise.all([
        readAllText(child.stdout),
        readAllText(child.stderr),
        child.exit,
      ]);

      // Assert
      assert.strictEqual(stdout, `<${envValue}>\n<${cwd}>\n`);
      assert.strictEqual(stderr, '');
      assert.deepStrictEqual(exit, {
        code: 0,
        signal: null,
        success: true,
      });
    } finally {
      if (live) await disposeLiveSandbox(live);
    }
  });

  it('streams stdout before the spawned command exits', async () => {
    // Arrange
    let live: LiveSandbox | undefined;
    try {
      live = await createLiveSandbox();
      const spawn = live.sandbox.spawn;
      assert.ok(spawn);

      // Act
      const child = spawn("printf 'first\\n'; sleep 2; printf 'second\\n'");
      const winner = await Promise.race([
        readFirstChunk(child.stdout).then((text) => ({
          kind: 'chunk' as const,
          text,
        })),
        child.exit.then((exit) => ({ kind: 'exit' as const, exit })),
      ]);

      // Assert
      assert.strictEqual(
        winner.kind,
        'chunk',
        'first stdout chunk must arrive before process exit',
      );
      assert.strictEqual(winner.kind === 'chunk' ? winner.text : '', 'first\n');
      const rest = await readAllText(child.stdout);
      assert.strictEqual(rest, 'second\n');
      assert.deepStrictEqual(await child.exit, {
        code: 0,
        signal: null,
        success: true,
      });
    } finally {
      if (live) await disposeLiveSandbox(live);
    }
  });
});
