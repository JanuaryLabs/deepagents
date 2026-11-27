import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import type { Citation, UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { ChatDataTypes } from '@deepagents/context';

import { citedAnswers } from '../../../../testing/cited-answers.ts';
import { StoredMessagesTransport } from '../../../../testing/stored-messages-transport.ts';
import { AgentProvider, useAgentMessages } from '../../agent-context.tsx';
import { CompactMessages } from './compact-messages.tsx';

type ChatMessage = UIMessage<unknown, ChatDataTypes>;

const question: ChatMessage = {
  id: 'question',
  role: 'user',
  parts: [{ type: 'text', text: 'How long does the paint take to dry?' }],
};

function Chat({ messages }: { messages: ChatMessage[] }) {
  return (
    <CompactMessages.Root messages={messages}>
      {messages.map((message, index) => (
        <CompactMessages.Item key={message.id} message={message} index={index}>
          {message.role === 'assistant' ? (
            <section data-testid="answer">
              <CompactMessages.AssistantContent />
              <CompactMessages.Actions>
                <CompactMessages.CopyAction />
              </CompactMessages.Actions>
            </section>
          ) : (
            <CompactMessages.UserBubble />
          )}
        </CompactMessages.Item>
      ))}
    </CompactMessages.Root>
  );
}

/** The answer as stored history draws it: the chat is idle. */
function renderStatic(parts: ChatMessage['parts']) {
  const answer: ChatMessage = { id: 'answer', role: 'assistant', parts };
  render(
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="consecutive-text-parts-static"
        transport={new StoredMessagesTransport()}
        onResetChat={() => undefined}
      >
        <Chat messages={[question, answer]} />
      </AgentProvider>
    </ClockProvider>,
  );
}

/** The stream the AI SDK reads for `parts`: each text part streams in small deltas and gets its citations at its text-end, as ai 7 gives them. */
function chunksOf(parts: ChatMessage['parts']): UIMessageChunk[] {
  return [
    { type: 'start', messageId: 'answer' },
    { type: 'start-step' },
    ...parts.flatMap((part, index): UIMessageChunk[] => {
      if (part.type === 'source-url')
        return [
          {
            type: 'source-url',
            sourceId: part.sourceId,
            url: part.url,
            ...(part.title === undefined ? {} : { title: part.title }),
          },
        ];
      if (part.type !== 'text') return [];
      const id = `text-${index}`;
      const deltas = part.text.match(/[\s\S]{1,24}/g) ?? [];
      return [
        { type: 'text-start', id },
        ...deltas.map((delta): UIMessageChunk => ({
          type: 'text-delta',
          id,
          delta,
        })),
        {
          type: 'text-end',
          id,
          ...(part.citations ? { citations: part.citations } : {}),
        },
      ];
    }),
  ];
}

/** A transport that streams `parts` and holds the stream open, so the chat stays in its streaming state. */
class OpenStreamTransport extends StoredMessagesTransport {
  readonly #chunks: UIMessageChunk[];
  readonly #open: ReadableStreamDefaultController<UIMessageChunk>[] = [];

  constructor(parts: ChatMessage['parts']) {
    super();
    this.#chunks = chunksOf(parts);
  }

  override sendMessages = (): Promise<ReadableStream<UIMessageChunk>> =>
    Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          this.#open.push(controller);
          for (const chunk of this.#chunks) controller.enqueue(chunk);
        },
      }),
    );

  close() {
    for (const controller of this.#open) controller.close();
  }
}

function LiveChat() {
  const { messages, status, sendMessage } = useAgentMessages();
  return (
    <>
      <button type="button" onClick={() => void sendMessage(question)}>
        Ask
      </button>
      <output data-testid="status">{status}</output>
      <Chat messages={messages} />
    </>
  );
}

/** The answer while the model still streams it: every part has arrived, the stream is still open. */
async function renderStreaming(
  stack: DisposableStack,
  parts: ChatMessage['parts'],
) {
  const transport = new OpenStreamTransport(parts);
  stack.defer(() => transport.close());
  render(
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="consecutive-text-parts-streaming"
        transport={transport}
        onResetChat={() => undefined}
      >
        <LiveChat />
      </AgentProvider>
    </ClockProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

const BLOCK = 'p, ul, ol, h1, h2, h3, h4, h5, h6, table, pre, blockquote';

/**
 * What the reader sees of the answer: its Markdown blocks in order, the text
 * containers that hold them (each is one Markdown document, and the gap
 * between two documents is wider than the gap between two of its blocks),
 * and each pill with the block it sits in.
 */
function drawn() {
  const answer = screen.getByTestId('answer');
  const blocks = [...answer.querySelectorAll(BLOCK)].filter(
    (block) => !block.parentElement?.closest(BLOCK),
  );
  return {
    documents: new Set(blocks.map((block) => block.closest('.text-sm'))).size,
    blocks: blocks.map(
      (block) => `${block.tagName.toLowerCase()}: ${block.textContent}`,
    ),
    pills: screen
      .queryAllByRole('button', { name: /^Source / })
      .map(
        (pill) =>
          `${pill.getAttribute('aria-label')} in "${pill.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6')?.textContent}"`,
      ),
  };
}

function stubClipboard(stack: DisposableStack) {
  const copied: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  });
  stack.defer(() => Reflect.deleteProperty(navigator, 'clipboard'));
  return copied;
}

async function copyAnswer(copied: string[]) {
  await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
  return copied.at(-1);
}

/** The one-part answer, drawn and copied as stored history: what the split answer must match. */
async function oneBlockAnswer(parts: ChatMessage['parts']) {
  using stack = new DisposableStack();
  stack.defer(cleanup);
  const copied = stubClipboard(stack);
  renderStatic(parts);
  return { drawn: drawn(), copied: await copyAnswer(copied) };
}

// @ai-sdk/anthropic gives a cited span its own text block and puts the
// citation, with no offsets, on that block's text-end (createTextEnd and
// mapAnthropicCitation in @ai-sdk/anthropic 4.0.108).
const anthropicSource = {
  type: 'source',
  sourceType: 'url',
  id: 'https://example.org/paint-guide',
  url: 'https://example.org/paint-guide',
  title: 'Paint guide: drying times',
} as const;
const anthropicCitation: Citation = {
  source: {
    ...anthropicSource,
    providerMetadata: {
      anthropic: {
        type: 'web_search_result_location',
        url: anthropicSource.url,
        title: anthropicSource.title,
        cited_text:
          'Allow 2.5 hours between coats when the room is cold or damp',
        encrypted_index: 'EpIBCioIBRgCIiQ',
      },
    },
  },
  citedText: 'Allow 2.5 hours between coats when the room is cold or damp',
};
const anthropicSplit: ChatMessage['parts'] = [
  {
    type: 'text',
    text: 'For most walls wait **5 hours between coats**; ',
    state: 'done',
  },
  {
    type: 'text',
    text: 'wait *2.5 more hours* when two of humidity ≥80%, temperature ≤10 °C or coat ≥1.5 mm apply',
    state: 'done',
    citations: [anthropicCitation],
  },
  {
    type: 'text',
    text: '. A fan alone does not shorten the wait.',
    state: 'done',
  },
];
const anthropicSentence =
  'For most walls wait 5 hours between coats; wait 2.5 more hours when two of humidity ≥80%, temperature ≤10 °C or coat ≥1.5 mm apply1. A fan alone does not shorten the wait.';

describe.each(citedAnswers)(
  'a recorded per-paragraph $answer (#6058)',
  ({ oneBlock, perParagraph }) => {
    it('draws, with its pills, as its one-part answer does in static mode', async () => {
      const expected = await oneBlockAnswer(oneBlock);
      using stack = new DisposableStack();
      stack.defer(cleanup);

      renderStatic(perParagraph);

      expect(drawn()).toEqual({ ...expected.drawn, documents: 1 });
    });

    it('draws, with its pills, as its one-part answer does in streaming mode', async () => {
      const expected = await oneBlockAnswer(oneBlock);
      using stack = new DisposableStack();
      stack.defer(cleanup);

      await renderStreaming(stack, perParagraph);

      await vi.waitFor(() =>
        expect(drawn().pills).toHaveLength(expected.drawn.pills.length),
      );
      expect({
        status: screen.getByTestId('status').textContent,
        drawn: drawn(),
      }).toEqual({
        status: 'streaming',
        drawn: { ...expected.drawn, documents: 1 },
      });
    });

    it("copies as its one-part answer does, with the screen's numbers", async () => {
      const expected = await oneBlockAnswer(oneBlock);
      using stack = new DisposableStack();
      stack.defer(cleanup);
      const copied = stubClipboard(stack);

      renderStatic(perParagraph);

      expect(await copyAnswer(copied)).toBe(expected.copied);
    });
  },
);

describe('consecutive text parts of one answer draw as one Markdown document (#6058)', () => {
  it('an Anthropic cited span, its own text part mid-sentence, draws inside its sentence with its pill at the span’s end in static mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderStatic(anthropicSplit);

    expect(drawn()).toEqual({
      documents: 1,
      blocks: [`p: ${anthropicSentence}`],
      pills: [`Source 1 in "${anthropicSentence}"`],
    });
  });

  it('an Anthropic cited span, its own text part mid-sentence, draws inside its sentence with its pill at the span’s end in streaming mode', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    await renderStreaming(stack, anthropicSplit);

    await vi.waitFor(() => expect(drawn().pills).toHaveLength(1));
    expect({
      status: screen.getByTestId('status').textContent,
      drawn: drawn(),
    }).toEqual({
      status: 'streaming',
      drawn: {
        documents: 1,
        blocks: [`p: ${anthropicSentence}`],
        pills: [`Source 1 in "${anthropicSentence}"`],
      },
    });
  });

  it('an Anthropic cited span copies inside its sentence, its [n] at the span’s end', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const copied = stubClipboard(stack);

    renderStatic(anthropicSplit);

    expect(await copyAnswer(copied)).toBe(
      [
        'For most walls wait **5 hours between coats**; wait *2.5 more hours* when two of humidity ≥80%, temperature ≤10 °C or coat ≥1.5 mm apply[1]. A fan alone does not shorten the wait.',
        '',
        '[1] Paint guide: drying times — https://example.org/paint-guide',
      ].join('\n'),
    );
  });

  it('a tool step between two text parts still ends the first document, on screen and in the copy', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const copied = stubClipboard(stack);

    renderStatic([
      { type: 'text', text: 'Let me check the guide.', state: 'done' },
      {
        type: 'tool-search',
        toolCallId: 'search-1',
        state: 'output-available',
        input: { question: 'paint drying time' },
        output: { status: 'searched' },
      },
      { type: 'text', text: 'Wait 5 hours between coats.', state: 'done' },
    ]);

    expect({
      documents: drawn().documents,
      copied: await copyAnswer(copied),
    }).toEqual({
      documents: 2,
      copied: 'Let me check the guide.\nWait 5 hours between coats.',
    });
  });
});
