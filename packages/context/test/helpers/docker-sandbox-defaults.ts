import type { DockerTestbed } from '@zukhruf/testing/docker';

/**
 * The testbed's defaults as Docker sandbox options: the run's labels, so the
 * global teardown sweeps the sandbox's containers and volumes, and its memory
 * and CPU limits in `docker run` units.
 */
export function dockerSandboxDefaults({
  Labels,
  HostConfig,
}: DockerTestbed['defaults']) {
  return {
    labels: Labels,
    resources: {
      memory: `${HostConfig.Memory}b`,
      cpus: HostConfig.NanoCpus / 1e9,
    },
  };
}
