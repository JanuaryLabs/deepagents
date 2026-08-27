import { render, screen } from '@testing-library/react';
import type { ChatStatus, UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  CompactMessages,
  CompactTrajectory,
  useTrajectoryItems,
} from './compact-messages.tsx';

const { mockUseAgentMessages, mockUseAgentStatus } = vi.hoisted(() => ({
  mockUseAgentMessages: vi.fn(() => ({ messages: [] })),
  mockUseAgentStatus: vi.fn((): { status: ChatStatus } => ({
    status: 'ready',
  })),
}));

vi.mock('../../agent-context.tsx', () => ({
  useAgent: () => ({
    debugMode: false,
    registry: {
      runQuery: {
        static: true,
        component: () => null,
        label: () => ({ name: 'runQuery', args: { db: 'ds1' } }),
      },
    },
    showActions: false,
  }),
  useAgentMessages: mockUseAgentMessages,
  useAgentStatus: mockUseAgentStatus,
}));

vi.mock('../../../copy/assistant-snapshot.tsx', () => ({
  useIsAssistantSnapshotRender: () => false,
}));

vi.mock('../../../components/InteractiveResponse.tsx', () => ({
  InteractiveResponse: ({ children }: { children: string }) => (
    <span>{children}</span>
  ),
}));

vi.mock('../../../renderers/render-part.tsx', () => ({
  RenderPart: () => <span>tool-output</span>,
}));

vi.mock('../../../components/tool-debug.tsx', () => ({
  ToolDebug: () => null,
  DynamicToolDebug: () => null,
}));

vi.mock('../../../elements/Response.tsx', () => ({
  Response: ({ children }: { children: string }) => <span>{children}</span>,
}));

vi.mock('../../usage.ts', () => ({
  parseMetadataUsage: () => null,
  formatUsageBreakdown: () => '',
}));

vi.mock('@deepagents/context/browser', () => ({
  stripReminders: (msg: UIMessage) => msg,
}));

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
    const message = makeToolGroupMessage();
    // No QueryClientProvider on purpose: the default assembly must be
    // fetch-free — mounting any query here would throw "No QueryClient set".
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.Item message={message} index={0}>
          <CompactMessages.AssistantContent />
        </CompactMessages.Item>
      </CompactMessages.Root>,
    );
    expect(screen.getByText(/Ran 2 tools/)).toBeInTheDocument();
    // genai is domain-agnostic: row signatures show registry args verbatim.
    expect(screen.getAllByText(/runQuery\(/)).toHaveLength(2);
    expect(screen.getAllByText(/ds1/).length).toBeGreaterThanOrEqual(2);
  });
});

describe('CompactTrajectory (recomposed from outside)', () => {
  it('renders a host-assembled group without DataSources and mounts no query', () => {
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
    );
    expect(screen.getByText(/Ran 2 tools/)).toBeInTheDocument();
    expect(screen.getAllByText(/runQuery\(/)).toHaveLength(2);
  });

  it('renders a host-overridden group title through the title prop', () => {
    const message = makeToolGroupMessage();
    function TitledContent() {
      const items = useTrajectoryItems();
      return items.map((item) =>
        item.kind === 'group' ? (
          <CompactTrajectory.Group key={item.key} group={item}>
            <CompactTrajectory.GroupTrigger>
              <CompactTrajectory.GroupTitle title="Queried 2 times · Prod DB">
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
    );
    expect(screen.getByText(/Queried 2 times · Prod DB/)).toBeInTheDocument();
  });

  it('appends the host suffix to the default title while the group is streaming', () => {
    mockUseAgentStatus.mockReturnValue({ status: 'streaming' });
    try {
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
        <CompactMessages.Root messages={[message]}>
          <CompactMessages.Item message={message} index={0}>
            <StreamingContent />
          </CompactMessages.Item>
        </CompactMessages.Root>,
      );
      expect(screen.getByText(/Working\.\.\. · Prod DB/)).toBeInTheDocument();
    } finally {
      mockUseAgentStatus.mockReturnValue({ status: 'ready' });
    }
  });
});
