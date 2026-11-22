import {
  DockerSandboxEnvironment,
  type StoppableSandboxEnvironment,
  pkg,
} from '@deepagents/context';

export function verifyDockerSandboxEnvironmentOptions(): StoppableSandboxEnvironment[] {
  return [
    new DockerSandboxEnvironment({ namespace: 'app', image: 'debian' }),
    new DockerSandboxEnvironment({
      namespace: 'app',
      dockerfile: 'FROM debian\n',
    }),
    new DockerSandboxEnvironment({
      namespace: 'app',
      volumes: ({ chatId }) => [
        { type: 'bind', hostPath: `/data/${chatId}`, containerPath: '/data' },
        { type: 'volume', name: 'uploads', containerPath: '/uploads' },
      ],
    }),
    new DockerSandboxEnvironment({
      namespace: 'app',
      // @ts-expect-error A worker could attach before installers finish: they belong in the image.
      installers: [pkg(['curl'])],
    }),
    // @ts-expect-error The environment names each chat's container.
    new DockerSandboxEnvironment({ namespace: 'app', name: 'fixed' }),
    // @ts-expect-error A chat's container is named from a namespace.
    new DockerSandboxEnvironment({ image: 'debian' }),
    // @ts-expect-error The image comes from an image or a Dockerfile, not both.
    new DockerSandboxEnvironment({
      namespace: 'app',
      image: 'debian',
      dockerfile: 'FROM debian\n',
    }),
    new DockerSandboxEnvironment({
      namespace: 'app',
      // @ts-expect-error Compose stacks stay one-off sandboxes.
      compose: 'compose.yml',
      service: 'app',
    }),
    new DockerSandboxEnvironment({
      namespace: 'app',
      // @ts-expect-error Volumes are given per chat.
      volumes: [{ type: 'bind', hostPath: '/data', containerPath: '/data' }],
    }),
    new DockerSandboxEnvironment({
      namespace: 'app',
      // @ts-expect-error A chat's volumes exist before it; the environment creates none.
      volumes: () => [
        {
          type: 'volume',
          name: 'scratch',
          containerPath: '/scratch',
          lifecycle: 'managed',
        },
      ],
    }),
    new DockerSandboxEnvironment({
      namespace: 'app',
      // @ts-expect-error The environment runs every chat container under an init.
      container: { HostConfig: { Init: false } },
    }),
  ];
}
