import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { StoredMessagesTransport } from '../../../../testing/stored-messages-transport.ts';
import type { ComponentRegistry } from '../../../tools/registry.ts';
import { AgentProvider } from '../../agent-context.tsx';
import {
  CompactMessages,
  CompactTrajectory,
  useTrajectoryItems,
} from './compact-messages.tsx';

const registry: ComponentRegistry = {
  runQuery: {
    static: true,
    component: () => null,
    label: () => ({ name: 'runQuery', args: { db: 'ds1' } }),
  },
};

function AgentHarness({ children }: { children: ReactNode }) {
  return (
    <AgentProvider
      chatId="compact-messages-test"
      debugMode={false}
      registry={registry}
      transport={new StoredMessagesTransport()}
      onResetChat={() => undefined}
    >
      {children}
    </AgentProvider>
  );
}

function makeToolGroupMessage(): UIMessage {
  return {
    id: 'asst-tools',
    role: 'assistant',
    parts: [
      {
        type: 'tool-runQuery',
        toolCallId: 'tc-1',
        state: 'output-available',
        input: { query: 'select 1', db: 'ds1' },
        output: 'ok',
      },
      {
        type: 'tool-runQuery',
        toolCallId: 'tc-2',
        state: 'output-available',
        input: { query: 'select 2', db: 'ds1' },
        output: 'ok',
      },
    ],
  };
}

describe('CompactMessages.AssistantContent (default assembly)', () => {
  it('groups consecutive tool calls under an activity summary without any data requirements', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeToolGroupMessage();
    // No QueryClientProvider on purpose: the default assembly must be
    // fetch-free — mounting any query here would throw "No QueryClient set".
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.Item message={message} index={0}>
          <CompactMessages.AssistantContent />
        </CompactMessages.Item>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText(/Ran 2 tools/)).toBeInTheDocument();
    // genai is domain-agnostic: row signatures show registry args verbatim.
    expect(screen.getAllByText(/runQuery\(/)).toHaveLength(2);
    expect(screen.getAllByText(/ds1/).length).toBeGreaterThanOrEqual(2);
  });
});

describe('CompactTrajectory (recomposed from outside)', () => {
  it('renders a host-assembled group without DataSources and mounts no query', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function RecomposedContent() {
      const items = useTrajectoryItems();
      return items.map((item) =>
        item.kind === 'group' ? (
          <CompactTrajectory.Group key={item.key} group={item}>
            <CompactTrajectory.GroupTrigger>
              <CompactTrajectory.GroupTitle>
                <CompactTrajectory.GroupChevron />
              </CompactTrajectory.GroupTitle>
              <CompactTrajectory.GroupDetail />
            </CompactTrajectory.GroupTrigger>
            <CompactTrajectory.GroupContent />
          </CompactTrajectory.Group>
        ) : (
          <CompactTrajectory.Segment key={item.key} item={item} />
        ),
      );
    }

    const message = makeToolGroupMessage();
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.Item message={message} index={0}>
          <RecomposedContent />
        </CompactMessages.Item>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText(/Ran 2 tools/)).toBeInTheDocument();
    expect(screen.getAllByText(/runQuery\(/)).toHaveLength(2);
  });

  it('renders a host-overridden group title through the title prop', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeToolGroupMessage();
    function TitledContent() {
      const items = useTrajectoryItems();
      return items.map((item) =>
        item.kind === 'group' ? (
          <CompactTrajectory.Group key={item.key} group={item}>
            <CompactTrajectory.GroupTrigger>
              <CompactTrajectory.GroupTitle title="Host-provided activity">
                <CompactTrajectory.GroupChevron />
              </CompactTrajectory.GroupTitle>
            </CompactTrajectory.GroupTrigger>
            <CompactTrajectory.GroupContent />
          </CompactTrajectory.Group>
        ) : null,
      );
    }
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.Item message={message} index={0}>
          <TitledContent />
        </CompactMessages.Item>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('Host-provided activity')).toBeInTheDocument();
  });

  it('appends the host suffix to the default title while the group is streaming', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message: UIMessage = {
      id: 'asst-streaming',
      role: 'assistant',
      parts: [
        {
          type: 'tool-runQuery',
          toolCallId: 'tc-run',
          state: 'input-available',
          input: { query: 'select 1', db: 'ds1' },
        },
      ],
    };
    function StreamingContent() {
      const items = useTrajectoryItems();
      return items.map((item) =>
        item.kind === 'group' ? (
          <CompactTrajectory.Group key={item.key} group={item}>
            <CompactTrajectory.GroupTrigger>
              <CompactTrajectory.GroupTitle suffix="Prod DB" />
            </CompactTrajectory.GroupTrigger>
          </CompactTrajectory.Group>
        ) : null,
      );
    }
    render(
      <CompactMessages.Root messages={[message]} status="streaming">
        <CompactMessages.Item message={message} index={0}>
          <StreamingContent />
        </CompactMessages.Item>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText(/Working\.\.\. · Prod DB/)).toBeInTheDocument();
  });
});
