import { NetworkPolicy } from 'microsandbox';

import { MicrosandboxSandboxEnvironment } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

import {
  groupChatDirectory,
  groupChatHostDirectory,
  groupChatRunId,
  sandboxRunLabel,
} from './environment.ts';

export default function createGroupChatSandbox(readonly: boolean) {
  return defineSandbox(
    new MicrosandboxSandboxEnvironment({
      namespace: 'zukhruf-group-chat',
      image: 'alpine',
      workdir: groupChatDirectory,
      configure: (builder) =>
        builder
          .label(sandboxRunLabel, groupChatRunId)
          .network((network) => network.policy(NetworkPolicy.none()))
          .volume(groupChatDirectory, (mount) => {
            const shared = mount
              .bind(groupChatHostDirectory)
              .noexec()
              .nosuid()
              .nodev();
            return readonly ? shared.readonly() : shared;
          }),
    }),
    { workingDirectory: groupChatDirectory },
  );
}

export const managerSandbox = createGroupChatSandbox(false);
