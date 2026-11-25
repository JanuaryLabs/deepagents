import spawn, { SubprocessError } from 'nano-spawn';

const PROBE_IMAGE = 'docker.io/library/bash:5.3-alpine3.24';

/**
 * Says why this host cannot run Apple containers, or `undefined` when it can.
 * It boots a throwaway container, because only that proves the service and its
 * guest kernel both work; `container system status` answers that the service
 * runs, not that a container starts.
 */
export async function appleContainerUnavailable(): Promise<string | undefined> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return 'Apple containers need Apple silicon';
  }
  const name = `probe-usable-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await spawn('container', [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      PROBE_IMAGE,
      'tail',
      '-f',
      '/dev/null',
    ]);
  } catch (error) {
    if (!(error instanceof SubprocessError)) throw error;
    return 'the Apple `container` CLI cannot start a container on this host';
  }
  await spawn('container', ['stop', name]);
  return undefined;
}
