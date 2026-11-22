import {
  type DisposableSandbox,
  createAppleContainerSandbox,
  createDockerSandbox,
} from '@deepagents/context';

export function verifyOneOffSandboxOptions(): Promise<DisposableSandbox>[] {
  return [
    createDockerSandbox({ image: 'debian' }),
    createDockerSandbox({ dockerfile: 'FROM debian\n' }),
    createAppleContainerSandbox({ image: 'debian' }),
    createAppleContainerSandbox({ dockerfile: 'FROM debian\n' }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createDockerSandbox({ name: 'fixed' }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createDockerSandbox({ dockerfile: 'FROM debian\n', name: 'fixed' }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createAppleContainerSandbox({ name: 'fixed' }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createAppleContainerSandbox({ dockerfile: 'FROM debian\n', name: 'fixed' }),
  ];
}
