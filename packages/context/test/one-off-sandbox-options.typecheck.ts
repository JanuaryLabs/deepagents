import type { DaytonaV2Client } from '@daytona/sdk';

import {
  DaytonaSandboxEnvironment,
  type DisposableSandbox,
  type SandboxEnvironment,
  type StoppableSandboxEnvironment,
  createAppleContainerSandbox,
  createDaytonaSandbox,
  createDockerSandbox,
  createMicrosandboxSandbox,
} from '@deepagents/context';

export function verifyOneOffSandboxOptions(
  daytona: DaytonaV2Client,
): Promise<DisposableSandbox>[] {
  return [
    createDockerSandbox({ image: 'debian' }),
    createDockerSandbox({ dockerfile: 'FROM debian\n' }),
    createAppleContainerSandbox({ image: 'debian' }),
    createAppleContainerSandbox({ dockerfile: 'FROM debian\n' }),
    createMicrosandboxSandbox({ workdir: '/srv' }),
    createDaytonaSandbox(daytona, { image: 'debian', labels: { app: 'x' } }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createDockerSandbox({ name: 'fixed' }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createDockerSandbox({ dockerfile: 'FROM debian\n', name: 'fixed' }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createAppleContainerSandbox({ name: 'fixed' }),
    // @ts-expect-error A one-off's container is never reached again: it gets a generated name.
    createAppleContainerSandbox({ dockerfile: 'FROM debian\n', name: 'fixed' }),
    // @ts-expect-error A one-off's VM is never reached again: it gets a generated name.
    createMicrosandboxSandbox({ name: 'fixed' }),
    // @ts-expect-error A one-off's VM is always created fresh: there is no VM of its name to replace.
    createMicrosandboxSandbox({ replace: true }),
    // @ts-expect-error A one-off's sandbox is never reached again: Daytona gives it a generated name.
    createDaytonaSandbox(daytona, { name: 'fixed' }),
    // @ts-expect-error A one-off always creates its own sandbox: it never attaches to one.
    createDaytonaSandbox(daytona, { sandboxId: 'sbx_existing' }),
  ];
}

export function verifyDaytonaSandboxEnvironment(
  daytona: DaytonaV2Client,
): SandboxEnvironment[] {
  const environment = new DaytonaSandboxEnvironment(daytona, {
    namespace: 'app',
    image: 'debian',
    lifecyclePolicy: { idleExpirySeconds: 600, onIdleTimeout: 'delete' },
  });
  // @ts-expect-error A Linux Daytona sandbox has no stopped state.
  const stoppable: StoppableSandboxEnvironment = environment;
  return [
    environment,
    stoppable,
    // @ts-expect-error The environment names each chat's sandbox.
    new DaytonaSandboxEnvironment(daytona, { namespace: 'app', name: 'fixed' }),
    // @ts-expect-error A chat's sandbox is named from a namespace.
    new DaytonaSandboxEnvironment(daytona, { image: 'debian' }),
    // @ts-expect-error One volume list would mount the same volumes in every chat.
    new DaytonaSandboxEnvironment(daytona, { namespace: 'app', volumes: [] }),
  ];
}
