import type { DockerBindVolume } from './docker-sandbox.ts';

export interface GcsVolumeOptions {
  /**
   * Host path where the GCS bucket is already mounted — typically the
   * mountpoint of `gcsfuse <bucket> <hostPath>` run on the Docker daemon host.
   * The host does the FUSE mount; see the GCS Cloud Storage recipe in the docs
   * for the host-side setup.
   */
  hostPath: string;
  /** Absolute path inside the container where the bucket appears. */
  mountPath: string;
  /** Default: `false`. */
  readOnly?: boolean;
}

/**
 * A Docker bind volume over a GCS bucket mounted on the **daemon host** (via
 * gcsfuse). The sandbox gets no capabilities and runs no in-container FUSE — it
 * just sees the host mountpoint. All cloud wiring (gcsfuse, credentials, IAM)
 * lives on the host, where it belongs.
 *
 * Prerequisite: the bucket must already be mounted at `hostPath` on the daemon
 * host before the sandbox starts. This works only when you run on the same host
 * as the Docker daemon (a Linux daemon host) — not macOS/Docker Desktop, where
 * the daemon host is a hidden VM. See the GCS Cloud Storage recipe.
 *
 * @example
 * ```ts
 * // On the daemon host first: gcsfuse my-bucket /mnt/my-bucket
 * const sandbox = await createDockerSandbox({
 *   volumes: [gcs({ hostPath: '/mnt/my-bucket', mountPath: '/workspace/gcs' })],
 * });
 * ```
 */
export function gcs(options: GcsVolumeOptions): DockerBindVolume {
  return {
    type: 'bind',
    hostPath: options.hostPath,
    containerPath: options.mountPath,
    readOnly: options.readOnly ?? false,
  };
}
