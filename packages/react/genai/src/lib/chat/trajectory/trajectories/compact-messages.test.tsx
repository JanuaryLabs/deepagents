import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatStatus, ToolUIPart, UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StoredMessagesTransport } from '../../../../testing/stored-messages-transport.ts';
import type { ComponentRegistry, ToolLabel } from '../../../tools/registry.ts';
import { AgentProvider } from '../../agent-context.tsx';
import {
  CompactMessages,
  CompactTrajectory,
  useTrajectoryItems,
} from './compact-messages.tsx';
import { Messages } from './messages.tsx';

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

// A host that labels its steps with sentences, as an end-user chat shows them:
// each tool input carries the sentence its label returns.
const sentenceInput = z.object({
  say: z.string(),
  detail: z.string().optional(),
});

const sentenceRegistry: ComponentRegistry = {
  search: {
    static: true,
    component: () => null,
    label: (part) => {
      const { say, detail } = sentenceInput.parse(part.input);
      return {
        kind: 'sentence',
        text: say,
        detail,
        isError: part.state === 'output-error',
      };
    },
  },
  runQuery: registry.runQuery,
};

function SentenceHarness({ children }: { children: ReactNode }) {
  return (
    <AgentProvider
      chatId="compact-sentence-test"
      debugMode={false}
      registry={sentenceRegistry}
      transport={new StoredMessagesTransport()}
      onResetChat={() => undefined}
    >
      {children}
    </AgentProvider>
  );
}

let sentenceCall = 0;

function searchStep(
  say: string,
  {
    state = 'output-available',
    detail,
    query,
  }: { state?: ToolUIPart['state']; detail?: string; query?: string } = {},
): UIMessage['parts'][number] {
  const input = { say, detail, query };
  const toolCallId = `search-${++sentenceCall}`;
  if (state === 'output-available') {
    return { type: 'tool-search', toolCallId, state, input, output: 'ok' };
  }
  if (state === 'output-error') {
    return { type: 'tool-search', toolCallId, state, input, errorText: 'x' };
  }
  return { type: 'tool-search', toolCallId, state: 'input-available', input };
}

function renderCompact(
  parts: UIMessage['parts'],
  status: ChatStatus = 'ready',
) {
  const message: UIMessage = {
    id: `asst-${++sentenceCall}`,
    role: 'assistant',
    parts,
  };
  render(
    <CompactMessages.Root messages={[message]} status={status}>
      <CompactMessages.Item message={message} index={0}>
        <CompactMessages.AssistantContent />
      </CompactMessages.Item>
    </CompactMessages.Root>,
    { wrapper: SentenceHarness },
  );
  return screen.getAllByRole('button')[0];
}

const answer = { type: 'text', text: 'The dose is 5 mg twice daily.' } as const;

describe('CompactMessages with sentence labels', () => {
  it('shows one step as its sentence alone', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const trigger = renderCompact([
      searchStep('Searched apixaban · 10 passages from PubMed'),
      answer,
    ]);

    expect(trigger).toHaveTextContent(
      /^Searched apixaban · 10 passages from PubMed$/,
    );
  });

  it('shows several steps as the latest sentence and how many others ran', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const trigger = renderCompact([
      searchStep('Searched apixaban · 10 passages'),
      searchStep('Searched ELIQUIS dosage · 4 passages'),
      searchStep('Read the ELIQUIS label'),
      answer,
    ]);

    expect(trigger).toHaveTextContent(/^Read the ELIQUIS label\s*\+2$/);
    expect(screen.queryByText('Searched apixaban · 10 passages')).toBeNull();
    await userEvent.click(trigger);
    expect(
      screen.getByText('Searched apixaban · 10 passages'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\(\)/)).toBeNull();
  });

  it('shows the running step as its sentence', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const trigger = renderCompact(
      [searchStep('Searching apixaban', { state: 'input-available' })],
      'streaming',
    );

    expect(trigger).toHaveTextContent(/^Searching apixaban$/);
  });

  it('draws an Arabic sentence in its own direction on the group line and the step row', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const sentence = 'بحث عن أبيكسابان · 10 مقاطع';
    const trigger = renderCompact([searchStep(sentence), answer]);
    await userEvent.click(trigger);

    const lines = screen.getAllByText(sentence);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveAttribute('dir', 'auto');
  });

  it("shows a sentence step's detail under it in its own direction", () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderCompact([
      searchStep('Searched apixaban · 4 passages', {
        detail: 'PubMed could not be searched',
      }),
      answer,
    ]);

    expect(screen.getByText('PubMed could not be searched')).toHaveAttribute(
      'dir',
      'auto',
    );
  });

  it("shows none of a sentence step's input", () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderCompact([
      searchStep('Searched apixaban', { query: 'select 1' }),
      answer,
    ]);

    expect(screen.queryByText(/select 1/)).toBeNull();
  });

  it('keeps the tool count when the latest step is a call label', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const trigger = renderCompact([
      searchStep('Searched apixaban'),
      {
        type: 'tool-runQuery',
        toolCallId: 'run-after-search',
        state: 'output-available',
        input: { query: 'select 1', db: 'ds1' },
        output: 'ok',
      },
      answer,
    ]);

    expect(trigger).toHaveTextContent(/Ran 2 tools/);
  });

  it('shows a failed step as its sentence', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const trigger = renderCompact([
      searchStep('Could not search apixaban', { state: 'output-error' }),
      answer,
    ]);

    expect(trigger).toHaveTextContent(/^Could not search apixaban$/);
  });

  it('shows a cancelled step as its sentence', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const trigger = renderCompact([
      searchStep('Searching apixaban', { state: 'input-available' }),
    ]);

    expect(trigger).toHaveTextContent(/^Searching apixaban$/);
  });

  it('draws a sentence step in Messages as the sentence in its own direction', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message: UIMessage = {
      id: 'asst-messages-sentence',
      role: 'assistant',
      parts: [searchStep('بحث عن أبيكسابان')],
    };
    render(
      <Messages.Root messages={[message]}>
        <Messages.Item message={message} index={0}>
          <Messages.AssistantContent />
        </Messages.Item>
      </Messages.Root>,
      { wrapper: SentenceHarness },
    );

    expect(screen.getByText('بحث عن أبيكسابان')).toHaveAttribute('dir', 'auto');
    expect(screen.queryByText(/\(/)).toBeNull();
  });

  it('refuses call args on a sentence label', () => {
    const label: ToolLabel = {
      kind: 'sentence',
      text: 'Searched apixaban',
      // @ts-expect-error a sentence is the whole line: it has no call args.
      args: {},
    };
    expect(label.kind).toBe('sentence');
  });
});
