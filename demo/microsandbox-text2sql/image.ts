// Single source of truth for the demo image. bootstrap.ts builds it with
// Docker and loads it straight into the local microsandbox image cache — no
// registry involved. Keep the tag pinned so re-runs of the demo hit the cached
// image instead of racing a moving :latest.
export const imageRepository = 'deepagents-text2sql';
export const imageTag = '0.1.0';

/** Image reference shared by the Docker build and the microsandbox cache. */
export const demoImage = `${imageRepository}:${imageTag}`;
