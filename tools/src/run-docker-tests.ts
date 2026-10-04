import command, { SubprocessError } from 'nano-spawn';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(
  new URL('../../.nx/docker-test-runs/', import.meta.url),
);
const label = 'dev.deepagents.test.run';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
interface Run {
  id: string;
  endpoint: string;
  pid: number | null;
  childPid?: number;
}

function alive(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function cleanup(run: Run, directory: string): Promise<void> {
  const signal = AbortSignal.timeout(60_000);
  const env = { DOCKER_CONTEXT: undefined, DOCKER_HOST: run.endpoint };
  const docker = (args: string[]) =>
    command('docker', args, { env, timeout: 30_000, signal });
  // Labels are attached atomically at creation. Never prune a daemon, remove
  // shared servers, or trust names alone as proof of ownership.
  const { stdout } = await docker([
    'ps',
    '-aq',
    '--filter',
    `label=${label}=${run.id}`,
  ]);
  for (const id of stdout.split('\n').filter(Boolean)) {
    try {
      const { stdout: shared } = await docker([
        'inspect',
        '--format',
        '{{index .Config.Labels "dev.deepagents.test.shared"}}',
        id,
      ]);
      if (shared !== '1') await docker(['rm', '--force', id]);
    } catch (error) {
      if (
        !(error instanceof SubprocessError) ||
        !/No such (object|container)/i.test(error.stderr)
      )
        throw error;
    }
  }
  const { stdout: volumes } = await docker([
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=${label}=${run.id}`,
  ]);
  for (const name of volumes.split('\n').filter(Boolean)) {
    await docker(['volume', 'rm', name]).catch((error) => {
      if (
        !(error instanceof SubprocessError) ||
        !/no such volume/i.test(error.stderr)
      )
        throw error;
    });
  }
  for (const file of await readdir(directory)) {
    if (!file.startsWith('directory-')) continue;
    const { path } = JSON.parse(
      await readFile(join(directory, file), 'utf8'),
    ) as { path: string };
    if (!path.includes(`/deepagents-test-${run.id}-`) || path.includes('/../'))
      throw new Error(`Invalid fixture cleanup record: ${path}`);
    if (run.endpoint.startsWith('ssh://')) {
      const url = new URL(run.endpoint);
      await command(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=10',
          ...(url.port ? ['-p', url.port] : []),
          ...(url.username ? ['-l', decodeURIComponent(url.username)] : []),
          url.hostname,
          `rm -rf -- ${quote(path)}`,
        ],
        { timeout: 30_000, signal },
      );
    } else await rm(path, { recursive: true, force: true });
  }
  await rm(directory, { recursive: true, force: true });
}

await mkdir(root, { recursive: true });
const { stdout } = await command(
  'docker',
  ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
  { timeout: 15_000 },
);
const endpoint = stdout.trim();
if (!/^(unix|ssh):\/\//.test(endpoint))
  throw new Error(`Unsupported Docker endpoint: ${endpoint}`);
for (const name of await readdir(root)) {
  const directory = join(root, name);
  let previous: Run;
  try {
    previous = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch {
    continue;
  } // Another runner may still be writing its metadata.
  if (
    previous.endpoint !== endpoint ||
    alive(previous.pid) ||
    alive(previous.childPid)
  )
    continue;
  try {
    await cleanup(previous, directory);
  } catch (error) {
    throw new Error(
      `Could not recover Docker test resources. Retained ownership record: ${directory}`,
      { cause: error },
    );
  }
}

const run: Run = { id: randomUUID(), endpoint, pid: process.pid };
const directory = join(root, run.id);
await mkdir(directory);
const record = async () => {
  const pending = join(directory, 'run.pending.json');
  await writeFile(pending, JSON.stringify(run));
  await rename(pending, join(directory, 'run.json'));
};
await record();
const args = process.argv.slice(2);
if (
  endpoint.startsWith('ssh://') &&
  !args.some((arg) => arg.startsWith('--test-concurrency'))
)
  args.unshift('--test-concurrency=1');
const child = spawn(process.execPath, ['--test', ...args], {
  stdio: 'inherit',
  detached: true,
  env: {
    ...process.env,
    DOCKER_CONTEXT: undefined,
    DOCKER_HOST: endpoint,
    DEEPAGENTS_TEST_RUN_ID: run.id,
    DEEPAGENTS_TEST_RUN_DIR: directory,
  },
});
run.childPid = child.pid;
const exited = new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});
let interrupted = false;
const kill = (signal: NodeJS.Signals) => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};
let deadline: NodeJS.Timeout | undefined;
const interrupt = () => {
  interrupted = true;
  kill('SIGTERM');
  deadline ??= setTimeout(() => kill('SIGKILL'), 5_000);
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  await record();
  const code = await exited;
  process.exitCode = interrupted ? 130 : code;
} finally {
  if (deadline) clearTimeout(deadline);
  // Includes SSH channels in workers killed by node --test or --test-force-exit.
  kill('SIGKILL');
  try {
    await cleanup(run, directory);
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `Docker test cleanup failed; retained ownership record for retry: ${directory}`,
      error,
    );
  }
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
