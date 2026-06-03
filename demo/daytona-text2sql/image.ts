// Single source of truth for the demo image. bootstrap.ts builds + pushes it to
// the host-mapped registry port (localhost:6000); demo-daytona.ts references the
// SAME image by the runner-internal name (registry:6000). Keep the tag pinned —
// Daytona rejects :latest for snapshots, and a moving tag breaks buildkit cache.
export const imageRepository = 'deepagents-text2sql';
export const imageTag = '0.1.0';

/** Push target for `docker buildx --push` from the host. */
export const pushImage = `localhost:6000/${imageRepository}:${imageTag}`;

/** Reference the Daytona runner pulls from (in-network registry name). */
export const runnerImage = `registry:6000/${imageRepository}:${imageTag}`;
