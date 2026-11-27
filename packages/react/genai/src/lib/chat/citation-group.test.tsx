import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import type { Citation, UIMessage, UIMessageChunk } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { StoredMessagesTransport } from '../../testing/stored-messages-transport.ts';
import type { GenAIInteractiveElement } from '../components/InteractiveResponse.tsx';
import { AgentProvider, useAgentMessages } from './agent-context.tsx';
import { CompactMessages as Messages } from './trajectory/trajectories/compact-messages.tsx';

function AgentHarness({ children }: { children: ReactNode }) {
  return (
    <AgentProvider
      chatId="citation-group-test"
      debugMode={false}
      registry={{}}
      transport={new StoredMessagesTransport()}
      onResetChat={() => undefined}
    >
      {children}
    </AgentProvider>
  );
}

function urlCitation(url: string, endIndex: number): Citation {
  return {
    source: { type: 'source', sourceType: 'url', id: url, url, title: url },
    startIndex: 0,
    endIndex,
  };
}

// A real Meddit answer's sentences (#6206): each citation sits before the
// sentence's closing punctuation, where the model's marker was.
const arabic = 'ولا يُوصى به في القصور الكبدي الشديد.';
const english = 'Avoid apixaban in severe hepatic impairment (Child-Pugh C).';
const text = `${arabic} ${english}`;
const answer: UIMessage = {
  id: 'asst-1',
  role: 'assistant',
  parts: [
    {
      type: 'text',
      text,
      citations: [
        urlCitation('https://pubmed.example/1', arabic.length - 1),
        urlCitation('https://pubmed.example/2', arabic.length - 1),
        urlCitation('https://pubmed.example/3', text.length - 2),
      ],
    },
  ],
};

describe('citation pills and the text around them (#6206)', () => {
  it('keeps the word before a citation, consecutive citations and the closing punctuation after them in one group that does not wrap', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <Messages.Root messages={[answer]}>
        <Messages.Item message={answer} index={0}>
          <Messages.AssistantContent />
        </Messages.Item>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );

    const group = (name: string) =>
      screen.getByRole('button', { name }).closest('.whitespace-nowrap');
    expect({
      pair: group('Source 1')?.textContent,
      parenthesis: group('Source 3')?.textContent,
      sentence: screen.getByRole('button', { name: 'Source 1' }).closest('p')
        ?.textContent,
    }).toEqual({
      pair: 'الشديد12.',
      parenthesis: 'C3).',
      sentence:
        'ولا يُوصى به في القصور الكبدي الشديد12. Avoid apixaban in severe hepatic impairment (Child-Pugh C3).',
    });
  });

  it('leaves out of the group a word set apart by a space and a word too long for a narrow column', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const spaced = 'Reduce the dose ';
    const token = 'x'.repeat(17);
    const text = `${spaced}then see ${token}.`;
    const message: UIMessage = {
      id: 'asst-2',
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text,
          citations: [
            urlCitation('https://pubmed.example/1', spaced.length),
            urlCitation('https://pubmed.example/2', text.length - 1),
          ],
        },
      ],
    };

    render(
      <Messages.Root messages={[message]}>
        <Messages.Item message={message} index={0}>
          <Messages.AssistantContent />
        </Messages.Item>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );

    const group = (name: string) =>
      screen.getByRole('button', { name }).closest('.whitespace-nowrap');
    expect({
      spaced: group('Source 1')?.textContent,
      long: group('Source 2')?.textContent,
    }).toEqual({ spaced: '1', long: '2.' });
  });

  it('copies the answer with [n] where each citation sits and no markup of the group', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          copied = value;
          return Promise.resolve();
        },
      },
    });
    stack.defer(() => Reflect.deleteProperty(navigator, 'clipboard'));

    render(
      <ClockProvider clock={createClock()}>
        <Messages.Root messages={[answer]}>
          <Messages.Item message={answer} index={0}>
            <Messages.AssistantContent />
            <Messages.CopyAction />
          </Messages.Item>
        </Messages.Root>
      </ClockProvider>,
      { wrapper: AgentHarness },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(copied).toBe(
      [
        'ولا يُوصى به في القصور الكبدي الشديد[1][2]. Avoid apixaban in severe hepatic impairment (Child-Pugh C[3]).',
        '',
        '[1] https://pubmed.example/1 — https://pubmed.example/1',
        '[2] https://pubmed.example/2 — https://pubmed.example/2',
        '[3] https://pubmed.example/3 — https://pubmed.example/3',
      ].join('\n'),
    );
  });
});

// Meddit's no-source chip (#6273): a host element its citation transform
// writes where a marker cites no passage, so it sits where a pill would.
const noSource: GenAIInteractiveElement = {
  name: 'no-source',
  allowedAttributes: ['reason'],
  component: () => <sup>no source</sup>,
};
const noSourceTag = '<no-source reason="unknown-passage" />';
const arabicClaim = 'ولا يُوصى به في القصور الكبدي الشديد';
const englishClaim = 'Avoid apixaban after surgery';
const noSourceText = `${arabicClaim}${noSourceTag}. ${englishClaim}${noSourceTag}.`;

function chipGroups() {
  return screen
    .getAllByText('no source')
    .map((chip) => chip.closest('.whitespace-nowrap')?.textContent);
}

class OpenStreamTransport extends StoredMessagesTransport {
  readonly #text: string;
  readonly #open: ReadableStreamDefaultController<UIMessageChunk>[] = [];

  constructor(text: string) {
    super();
    this.#text = text;
  }

  override sendMessages = (): Promise<ReadableStream<UIMessageChunk>> =>
    Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          this.#open.push(controller);
          const chunks: UIMessageChunk[] = [
            { type: 'start', messageId: 'asst-live' },
            { type: 'start-step' },
            { type: 'text-start', id: 't' },
            ...(this.#text.match(/[\s\S]{1,24}/g) ?? []).map(
              (delta): UIMessageChunk => ({
                type: 'text-delta',
                id: 't',
                delta,
              }),
            ),
          ];
          for (const chunk of chunks) controller.enqueue(chunk);
        },
      }),
    );

  close() {
    for (const controller of this.#open) controller.close();
  }
}

function LiveChat({ elements }: { elements: GenAIInteractiveElement[] }) {
  const { messages, status, sendMessage } = useAgentMessages();
  return (
    <>
      <button type="button" onClick={() => void sendMessage({ text: 'Ask' })}>
        Ask
      </button>
      <output data-testid="status">{status}</output>
      <Messages.Root messages={messages} elements={elements}>
        {messages.map((message, index) =>
          message.role === 'assistant' ? (
            <Messages.Item key={message.id} message={message} index={index}>
              <Messages.AssistantContent />
            </Messages.Item>
          ) : null,
        )}
      </Messages.Root>
    </>
  );
}

describe("a host element in a citation's place (#6273)", () => {
  it('keeps the word before a declared inline element and the period after it in one group that does not wrap', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const message: UIMessage = {
      id: 'asst-3',
      role: 'assistant',
      parts: [{ type: 'text', text: noSourceText }],
    };

    render(
      <Messages.Root messages={[message]} elements={[noSource]}>
        <Messages.Item message={message} index={0}>
          <Messages.AssistantContent />
        </Messages.Item>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );

    expect({
      groups: chipGroups(),
      sentence: screen.getAllByText('no source')[0]?.closest('p')?.textContent,
    }).toEqual({
      groups: ['الشديدno source.', 'surgeryno source.'],
      sentence:
        'ولا يُوصى به في القصور الكبدي الشديدno source. Avoid apixaban after surgeryno source.',
    });
  });

  it('keeps the word, the element and the period together in streaming mode', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const transport = new OpenStreamTransport(noSourceText);
    stack.defer(() => transport.close());

    render(
      <ClockProvider clock={createClock()}>
        <AgentProvider
          chatId="citation-group-streaming"
          transport={transport}
          onResetChat={() => undefined}
        >
          <LiveChat elements={[noSource]} />
        </AgentProvider>
      </ClockProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));

    await vi.waitFor(() =>
      expect(screen.getAllByText('no source')).toHaveLength(2),
    );
    expect({
      status: screen.getByTestId('status').textContent,
      groups: chipGroups(),
    }).toEqual({
      status: 'streaming',
      groups: ['الشديدno source.', 'surgeryno source.'],
    });
  });

  it('groups a citation pill and a host element of one place together', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const claim = 'Avoid apixaban after surgery';
    const text = `${claim}${noSourceTag}.`;
    const message: UIMessage = {
      id: 'asst-4',
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text,
          citations: [urlCitation('https://pubmed.example/1', claim.length)],
        },
      ],
    };

    render(
      <Messages.Root messages={[message]} elements={[noSource]}>
        <Messages.Item message={message} index={0}>
          <Messages.AssistantContent />
        </Messages.Item>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );

    expect(chipGroups()).toEqual(['surgery1no source.']);
  });

  it('leaves out of any group a declared element alone on its line', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const message: UIMessage = {
      id: 'asst-5',
      role: 'assistant',
      parts: [
        { type: 'text', text: `${englishClaim}.\n\n${noSourceTag}\n\nDone.` },
      ],
    };

    render(
      <Messages.Root messages={[message]} elements={[noSource]}>
        <Messages.Item message={message} index={0}>
          <Messages.AssistantContent />
        </Messages.Item>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );

    expect(chipGroups()).toEqual([undefined]);
  });
});
