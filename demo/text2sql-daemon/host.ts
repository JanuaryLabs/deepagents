import pRetry from 'p-retry';

import type { DisposableSandbox } from '@deepagents/context';

// Host-side supervision for the text2sql daemon. Everything here operates
// purely through the DisposableSandbox public contract (`executeCommand`), so
// the same functions serve every backend demo: docker (daemon auto-starts as
// the image CMD — call `waitForDaemonReady`), daytona and microsandbox (the
// runtime never executes the image CMD — call `startDaemon`).

/** Workspace the bash tool cd's into; pre-created by the Dockerfile. */
export const demoWorkspace = '/tmp/deepagents-demo';
/** Where `sql` writes generated artifacts (TEXT2SQL_OUT_DIR). */
export const text2SqlOutDir = `${demoWorkspace}/sql`;

export const daemonPort = 4747;
export const daemonUrl = `http://127.0.0.1:${daemonPort}/rpc`;
/** Baked image path of the daemon entrypoint (see Dockerfile). */
export const daemonScript = '/repo/demo/text2sql-daemon/daemon/demo-daemon.ts';
/** Only written when `startDaemon` launches the daemon; the docker CMD path logs to container stdout instead. */
export const daemonLogPath = '/tmp/text2sql-daemon.log';

const DEFAULT_READY_TIMEOUT_MS = 15_000;

export interface WaitForDaemonReadyOptions {
  timeoutMs?: number;
}

export interface StartDaemonOptions extends WaitForDaemonReadyOptions {
  /**
   * Shell statement prefixed to the daemon launch command — e.g. the
   * microsandbox demo resolves PGHOST from the guest's default-route gateway
   * here. Runs in the same `sh` invocation, so exported variables reach the
   * daemon.
   */
  prelude?: string;
}

/**
 * Poll the daemon's /health endpoint until it accepts requests. Use directly
 * when the backend already launched the daemon (docker runs it as the image
 * CMD); `startDaemon` composes this for backends that don't.
 */
export async function waitForDaemonReady(
  sandbox: DisposableSandbox,
  options: WaitForDaemonReadyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const healthProbe =
    `node -e "fetch('http://127.0.0.1:${daemonPort}/health')` +
    `.then(r => r.ok ? r.text().then(t => { process.stdout.write(t); process.exit(0); }) : process.exit(1))` +
    `.catch(() => process.exit(1))"`;

  try {
    const health = await pRetry(
      async () => {
        const probe = await sandbox.executeCommand(healthProbe);
        if (probe.exitCode !== 0) {
          throw new Error('daemon not accepting requests yet');
        }
        return probe;
      },
      // factor 1 → fixed 250ms between attempts; the deadline, not a retry
      // count, bounds the wait.
      {
        retries: Number.POSITIVE_INFINITY,
        factor: 1,
        minTimeout: 250,
        maxRetryTime: timeoutMs,
      },
    );
    console.log(`[demo] daemon ready: ${health.stdout.trim()}`);
  } catch {
    throw new Error(
      `text2sql daemon did not become ready within ${timeoutMs}ms. ` +
        `Check that Postgres is reachable from the sandbox.${await logTail(sandbox)}`,
    );
  }
}

/**
 * Launch the daemon detached inside the sandbox, verify it survived its first
 * tick, then wait for readiness. For backends that never run the image CMD
 * (daytona, microsandbox).
 */
export async function startDaemon(
  sandbox: DisposableSandbox,
  options: StartDaemonOptions = {},
): Promise<void> {
  // POSIX sh (alpine) — no `disown` bash-ism; nohup + redirected stdio already
  // detaches the daemon so it survives this exec.
  const prelude = options.prelude ? `${options.prelude}; ` : '';
  const spawnResult = await sandbox.executeCommand(
    `${prelude}nohup node ${daemonScript} > ${daemonLogPath} 2>&1 < /dev/null & echo $!`,
  );
  const daemonPid = spawnResult.stdout.trim();
  if (spawnResult.exitCode !== 0 || !/^\d+$/.test(daemonPid)) {
    throw new Error(
      `failed to spawn daemon: ${spawnResult.stderr || spawnResult.stdout}`,
    );
  }

  const liveness = await sandbox.executeCommand(`kill -0 ${daemonPid}`);
  if (liveness.exitCode !== 0) {
    throw new Error(
      `daemon process ${daemonPid} died immediately.${await logTail(sandbox)}`,
    );
  }

  await waitForDaemonReady(sandbox, options);
}

async function logTail(sandbox: DisposableSandbox): Promise<string> {
  const log = await sandbox.executeCommand(
    `tail -50 ${daemonLogPath} 2>/dev/null || true`,
  );
  return log.stdout.trim() ? ` Log tail:\n${log.stdout}` : '';
}
