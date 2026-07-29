import { NetworkPolicy } from 'microsandbox';

import { createMicrosandboxSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

import {
  groupChatDirectory,
  groupChatHostDirectory,
  groupChatRunId,
  sandboxRunLabel,
} from './environment.ts';

function sandbox(readonly: boolean) {
  return defineSandbox(
    ({ chatId }) =>
      createMicrosandboxSandbox({
        name: `zukhruf-group-chat-${chatId}`,
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
    { destination: groupChatDirectory },
  );
}

export const managerSandbox = sandbox(false);
export const participantSandbox = sandbox(true);
