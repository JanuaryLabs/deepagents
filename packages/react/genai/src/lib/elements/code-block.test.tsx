import { createClock } from '@sinonjs/fake-timers';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import type { ChatTransport, UIMessage } from 'ai';
import { expect, test, vi } from 'vitest';

import {
  AgentProvider,
  CodeBlock,
  CodeBlockCopyButton,
  CompactMessages,
} from '@deepagents/react-genai';

const idleTransport: ChatTransport<UIMessage> & {
  uploadFile: () => never;
  cancel: () => never;
} = {
  sendMessages: () => Promise.reject(new Error('No sends expected')),
  reconnectToStream: () => Promise.resolve(null),
  uploadFile: () => {
    throw new Error('No uploads expected');
  },
  cancel: () => {
    throw new Error('No cancels expected');
  },
};

test('a JSON tool input renders highlighted tokens', async () => {
  const message: UIMessage = {
    id: 'tool-input',
    role: 'assistant',
    parts: [
      {
        type: 'tool-search',
        toolCallId: 'call-1',
        state: 'input-available',
        input: { query: 'revenue' },
      },
    ],
  };
  try {
    const { container } = render(
      <AgentProvider
        chatId="code-block-test"
        debugMode
        transport={idleTransport}
        onResetChat={() => {}}
      >
        <CompactMessages.Root messages={[message]} status="streaming">
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.AssistantContent />
          </CompactMessages.Item>
        </CompactMessages.Root>
      </AgentProvider>,
    );

    await userEvent.click(
      screen.getByRole('button', { name: /Executing search/ }),
    );

    const tokens = await vi.waitFor(() => {
      const highlighted = [
        ...container.querySelectorAll('span[style*="--shiki-light"]'),
      ].map((token) => token.textContent);
      expect(highlighted).not.toHaveLength(0);
      return highlighted;
    });
    expect(tokens.some((text) => text.includes('query'))).toBe(true);
    expect(tokens.some((text) => text.includes('revenue'))).toBe(true);
  } finally {
    cleanup();
  }
});

test('showLineNumbers numbers every line and wrap soft-wraps them', () => {
  try {
    const { container } = render(
      <CodeBlock code={'a\nb\nc'} language="text" showLineNumbers wrap />,
    );

    const content = container.querySelector('pre');
    expect(content).toHaveAttribute('data-numbered');
    expect(content).toHaveAttribute('data-wrap');
    expect(
      container.querySelectorAll('[data-slot="code-block-line"]'),
    ).toHaveLength(3);
  } finally {
    cleanup();
  }
});

test('without showLineNumbers and wrap, lines are neither numbered nor wrapped', () => {
  try {
    const { container } = render(<CodeBlock code="a" language="json" />);

    const content = container.querySelector('pre');
    expect(content).not.toHaveAttribute('data-numbered');
    expect(content).not.toHaveAttribute('data-wrap');
  } finally {
    cleanup();
  }
});

test('a language the highlighter does not know still renders its text', () => {
  try {
    render(<CodeBlock code="+++[>+<-]." language="brainfuck" />);

    expect(screen.getByText('+++[>+<-].')).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('the copy button writes the code and shows its check for the timeout of the host clock, then the copy icon again', async () => {
  const clock = createClock();
  const written: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    },
  });
  try {
    const { container } = render(
      <ClockProvider clock={clock}>
        <CodeBlock code="select 1" language="sql">
          <CodeBlockCopyButton aria-label="Copy code" timeout={500} />
        </CodeBlock>
      </ClockProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(written).toEqual(['select 1']);
    expect(container.querySelector('svg.lucide-check')).toBeInTheDocument();

    act(() => {
      clock.tick(499);
    });

    expect(container.querySelector('svg.lucide-check')).toBeInTheDocument();

    act(() => {
      clock.tick(1);
    });

    expect(container.querySelector('svg.lucide-check')).toBeNull();
    expect(container.querySelector('svg.lucide-copy')).toBeInTheDocument();
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard');
    cleanup();
  }
});
