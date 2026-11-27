import { cleanup, render } from '@testing-library/react';
import type { Citation, UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';

import { StoredMessagesTransport } from '../../testing/stored-messages-transport.ts';
import { AgentProvider } from '../chat/agent-context.tsx';
import { CompactMessages as Messages } from '../chat/trajectory/trajectories/compact-messages.tsx';
import {
  type GenAIInteractiveElement,
  InteractiveResponse,
} from '../components/InteractiveResponse.tsx';

function AgentHarness({ children }: { children: ReactNode }) {
  return (
    <AgentProvider
      chatId="block-direction-test"
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

const passageCite: GenAIInteractiveElement = {
  name: 'passage-cite',
  component: (props) => <sup>[{String(props.passage)}]</sup>,
  allowedAttributes: ['passage'],
};

// The dir of the answer's sentence, as the chat renders it: streamdown sets it
// on the paragraph's block (a display:contents wrapper in streaming mode).
function sentenceDirection(
  text: string,
  citations: Citation[] = [],
  elements?: GenAIInteractiveElement[],
) {
  const answer: UIMessage = {
    id: 'asst-1',
    role: 'assistant',
    parts: [{ type: 'text', text, citations }],
  };
  try {
    const { container } = render(
      <div dir="rtl">
        <Messages.Root messages={[answer]} elements={elements}>
          <Messages.Item message={answer} index={0}>
            <Messages.AssistantContent />
          </Messages.Item>
        </Messages.Root>
      </div>,
      { wrapper: AgentHarness },
    );
    return container.querySelector('p')?.closest('[dir]')?.getAttribute('dir');
  } finally {
    cleanup();
  }
}

// A real Meddit answer's sentence (#6229): each citation sits before the
// closing period, where the model's marker was.
const arabic = 'ولا يُوصى به في القصور الكبدي الشديد.';
const english = 'Avoid apixaban in severe hepatic impairment.';

test('a short sentence takes the direction of its own words, whatever citations or elements it holds (#6229)', () => {
  expect({
    arabicNoCitation: sentenceDirection(arabic),
    arabicOneCitation: sentenceDirection(arabic, [
      urlCitation('https://pubmed.example/1', arabic.length - 1),
    ]),
    arabicTwoCitations: sentenceDirection(arabic, [
      urlCitation('https://pubmed.example/1', arabic.length - 1),
      urlCitation('https://pubmed.example/2', arabic.length - 1),
    ]),
    arabicWithElement: sentenceDirection(
      'ولا يُوصى به <passage-cite passage="pubmed:12345" /> في القصور الكبدي الشديد.',
      [],
      [passageCite],
    ),
    englishOneCitation: sentenceDirection(english, [
      urlCitation('https://pubmed.example/1', english.length - 1),
    ]),
    arabicWithLongCode: sentenceDirection(
      'استخدم الدالة `someVeryLongFunctionNameInCode()` هنا.',
    ),
    englishInsideTags: sentenceDirection(
      `<span><passage-cite passage="pubmed:12345" /></span> ${english} <passage-cite passage="pubmed:67890" />`,
      [],
      [passageCite],
    ),
  }).toEqual({
    arabicNoCitation: 'rtl',
    arabicOneCitation: 'rtl',
    arabicTwoCitations: 'rtl',
    arabicWithElement: 'rtl',
    englishOneCitation: 'ltr',
    arabicWithLongCode: 'rtl',
    englishInsideTags: 'ltr',
  });
});

const noteBox: GenAIInteractiveElement = {
  name: 'note-box',
  component: (props) => <section>{props.children}</section>,
  allowedAttributes: [],
};

test('an element on a line of its own keeps the direction of the words inside it (#6229)', () => {
  const answer: UIMessage = {
    id: 'asst-1',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: '<note-box>هذا نص عربي أطول قليلا داخل عنصر تفاعلي في الرد</note-box>',
      },
    ],
  };
  try {
    const { container } = render(
      <div dir="rtl">
        <Messages.Root messages={[answer]} elements={[noteBox]}>
          <Messages.Item message={answer} index={0}>
            <Messages.AssistantContent />
          </Messages.Item>
        </Messages.Root>
      </div>,
      { wrapper: AgentHarness },
    );

    expect(
      container.querySelector('section')?.closest('[dir]')?.getAttribute('dir'),
    ).toBe('rtl');
  } finally {
    cleanup();
  }
});

// Static mode leaves the direction to streamdown's rehype pass, which reads
// only the rendered text of each paragraph, not its tags.
function staticSentenceDirection(text: string) {
  try {
    const { container } = render(
      <div dir="rtl">
        <InteractiveResponse elements={[passageCite]} mode="static">
          {text}
        </InteractiveResponse>
      </div>,
    );
    return container.querySelector('p')?.closest('[dir]')?.getAttribute('dir');
  } finally {
    cleanup();
  }
}

test('in static mode a short sentence also takes the direction of its own words, whatever elements it holds (#6229)', () => {
  expect({
    arabicNoElement: staticSentenceDirection(arabic),
    arabicTwoElements: staticSentenceDirection(
      'ولا يُوصى به <passage-cite passage="pubmed:12345" /> في القصور الكبدي الشديد <passage-cite passage="pubmed:67890" />.',
    ),
    englishOneElement: staticSentenceDirection(
      'Avoid apixaban in severe hepatic impairment <passage-cite passage="pubmed:12345" />.',
    ),
  }).toEqual({
    arabicNoElement: 'rtl',
    arabicTwoElements: 'rtl',
    englishOneElement: 'ltr',
  });
});
