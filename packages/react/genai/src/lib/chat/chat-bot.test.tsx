import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import { ClockProvider } from '@zukhruf/ui';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { StoredMessagesTransport } from '../../testing/stored-messages-transport.ts';
import { GenaiMessagesProvider } from '../i18n/provider.tsx';
import { AgentProvider } from './agent-context.tsx';
import { ChatBot } from './chat.tsx';
import { CompactMessages } from './trajectory/trajectories/compact-messages.tsx';

const question: UIMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Does apixaban need a dose change?' }],
};
const answer: UIMessage = {
  id: 'assistant-1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'No change in mild impairment.' }],
};
const followUp: UIMessage = {
  id: 'user-2',
  role: 'user',
  parts: [{ type: 'text', text: 'And in severe impairment?' }],
};

function Harness({ children }: { children: ReactNode }) {
  return (
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="chat-bot-test"
        transport={new StoredMessagesTransport()}
        onResetChat={() => undefined}
      >
        {children}
      </AgentProvider>
    </ClockProvider>
  );
}

function Chat({ messages }: { messages: UIMessage[] }) {
  return (
    <ChatBot>
      <CompactMessages.Root messages={messages} status="ready">
        <CompactMessages.List>
          {messages.map((message, index) => (
            <CompactMessages.Item
              key={message.id}
              message={message}
              index={index}
            >
              {message.role === 'user' ? (
                <CompactMessages.UserBubble />
              ) : (
                <CompactMessages.AssistantContent />
              )}
            </CompactMessages.Item>
          ))}
        </CompactMessages.List>
      </CompactMessages.Root>
      <ChatBot.ScrollButton />
    </ChatBot>
  );
}

describe('ChatBot', () => {
  it('starts each turn at a user message: every message is a row of the log, and only user messages anchor', () => {
    try {
      render(<Chat messages={[question, answer, followUp]} />, {
        wrapper: Harness,
      });

      const log = screen.getByRole('log');
      const rows = Array.from(log.children).filter(
        (row): row is HTMLElement =>
          row instanceof HTMLElement &&
          !row.hasAttribute('data-message-scroller-spacer'),
      );
      expect(
        rows.map((row) => [
          row.getAttribute('data-message-id'),
          row.getAttribute('data-scroll-anchor'),
        ]),
      ).toEqual([
        ['user-1', 'true'],
        ['assistant-1', 'false'],
        ['user-2', 'true'],
      ]);
      expect(rows.at(-1)).toHaveTextContent('And in severe impairment?');
    } finally {
      cleanup();
    }
  });

  it('names the scroll button with the English default and keeps it inert while nothing is below', () => {
    try {
      render(<Chat messages={[question, answer]} />, { wrapper: Harness });

      const button = screen.getByRole('button', {
        name: 'Scroll to the latest message',
        hidden: true,
      });
      expect(button).toHaveAttribute('inert');
      expect(button).toHaveAttribute('data-active', 'false');
    } finally {
      cleanup();
    }
  });

  it("names the scroll button from the host's catalog", () => {
    try {
      render(
        <GenaiMessagesProvider
          locale="ar"
          messages={{ 'chat.scrollToBottom': 'انتقل إلى آخر رسالة' }}
        >
          <Chat messages={[question, answer]} />
        </GenaiMessagesProvider>,
        { wrapper: Harness },
      );

      expect(
        screen.getByRole('button', {
          name: 'انتقل إلى آخر رسالة',
          hidden: true,
        }),
      ).toBeInTheDocument();
    } finally {
      cleanup();
    }
  });

  it("names the message region from the host's catalog, and Messages by default", () => {
    try {
      const { unmount } = render(<Chat messages={[question, answer]} />, {
        wrapper: Harness,
      });
      const english = screen.queryAllByRole('region', { name: 'Messages' });
      unmount();
      render(
        <GenaiMessagesProvider
          locale="ar"
          messages={{ 'chat.messagesRegion': 'الرسائل' }}
        >
          <Chat messages={[question, answer]} />
        </GenaiMessagesProvider>,
        { wrapper: Harness },
      );

      expect({
        english: english.length,
        arabic: screen.queryAllByRole('region', { name: 'الرسائل' }).length,
        untranslated: screen.queryAllByRole('region', { name: 'Messages' })
          .length,
      }).toEqual({ english: 1, arabic: 1, untranslated: 0 });
    } finally {
      cleanup();
    }
  });
});
