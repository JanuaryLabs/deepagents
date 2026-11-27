import type { ChatStatus, UIMessage } from 'ai';
import { type ComponentType, createContext, use } from 'react';

import type { GenAIInteractiveElement } from '../../components/InteractiveResponse.tsx';
import { useAgentStatus } from '../agent-context.tsx';
import type { UrlCitation } from '../citations.ts';

export type MessagesContextValue = {
  messages: UIMessage[];
  elements?: GenAIInteractiveElement[];
  /** Draws a text citation; react-genai's CitationPill when absent. */
  citation?: ComponentType<{ citation: UrlCitation; index: number }>;
  status?: ChatStatus;
};

type MessageItemContextValue = {
  message: UIMessage;
  index: number;
};

export const MessagesContext = createContext<MessagesContextValue | undefined>(
  undefined,
);
export const MessageItemContext = createContext<
  MessageItemContextValue | undefined
>(undefined);

export function useMessagesContext() {
  const ctx = use(MessagesContext);
  if (!ctx) {
    throw new Error('useMessagesContext must be used within <Messages>');
  }
  return ctx;
}

export function useMessagesStatus() {
  const ctx = use(MessagesContext);
  const { status } = useAgentStatus();
  // Soft fallback: status is derivable from agent context, so we don't
  // force callers to wrap in <Messages.Root> or pass status= just to read it.
  return ctx?.status ?? status;
}

export function useMessageItem() {
  const ctx = use(MessageItemContext);
  if (!ctx) {
    throw new Error('useMessageItem must be used within <Messages.Item>');
  }
  return ctx;
}
