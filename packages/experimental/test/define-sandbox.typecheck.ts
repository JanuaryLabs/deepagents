import type {
  AppleContainerSandboxEnvironment,
  DaytonaSandboxEnvironment,
  DockerSandboxEnvironment,
  MicrosandboxSandboxEnvironment,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import {
  type ZukhrufSandboxDeclaration,
  defineSandbox,
} from '@deepagents/experimental/zukhruf';

declare const docker: DockerSandboxEnvironment;
declare const apple: AppleContainerSandboxEnvironment;
declare const microsandbox: MicrosandboxSandboxEnvironment;
declare const virtual: VirtualSandboxEnvironment;
declare const daytona: DaytonaSandboxEnvironment;
declare const open: ZukhrufSandboxDeclaration['open'];

export function verifyDefineSandboxIdleTimeout(): ZukhrufSandboxDeclaration[] {
  return [
    defineSandbox(docker, { idleTimeoutMs: 60_000 }),
    defineSandbox(apple, { idleTimeoutMs: 0 }),
    defineSandbox(microsandbox, {
      idleTimeoutMs: false,
      workingDirectory: '/agent',
    }),
    defineSandbox(virtual),
    defineSandbox(daytona, { workingDirectory: '/agent' }),
    // @ts-expect-error A sandbox the runtime can stop declares how long it runs once its chat is idle.
    defineSandbox(docker),
    // @ts-expect-error A sandbox the runtime can stop declares how long it runs once its chat is idle.
    defineSandbox(apple, { workingDirectory: '/agent' }),
    // @ts-expect-error A sandbox the runtime can stop declares how long it runs once its chat is idle.
    defineSandbox(microsandbox),
    // @ts-expect-error A sandbox the runtime cannot stop has no idle time.
    defineSandbox(virtual, { idleTimeoutMs: 1 }),
    // @ts-expect-error A sandbox the runtime cannot stop has no idle time.
    defineSandbox(daytona, { idleTimeoutMs: false }),
    { environment: docker, idleTimeoutMs: 1000, open },
    { environment: virtual, open },
    // @ts-expect-error A sandbox the runtime can stop declares how long it runs once its chat is idle.
    { environment: docker, open },
    // @ts-expect-error A sandbox the runtime cannot stop has no idle time.
    { environment: virtual, idleTimeoutMs: 1000, open },
  ];
}
