#!/usr/bin/env node
import {
  DependencyChecks,
  DockerfileInstallsFromLockfile,
  Format,
  LockfileSync,
  NoNumericPins,
  NpmrcPolicy,
  Sync,
  WorkflowChecks,
  preCommit,
} from '@zukhruf/git-hooks';

await preCommit([
  new Sync({
    stage: [
      '**/tsconfig*.json',
      'apps/evals-web-runner/frontend/src/evals.openapi',
    ],
  }),
  new Format(),
  new NoNumericPins(),
  new NpmrcPolicy(),
  new LockfileSync(),
  new DockerfileInstallsFromLockfile(),
  new DependencyChecks(),
  new WorkflowChecks(),
]);
