import type { ChatStatus, UIMessage } from 'ai';
import { createContext, use } from 'react';

import type { GenAIInteractiveElement } from '../../components/InteractiveResponse.tsx';
import { useAgentStatus } from '../agent-context.tsx';

export type MessagesContextValue = {
  messages: UIMessage[];
  elements?: GenAIInteractiveElement[];
  status?: ChatStatus;
};

type MessageItemContextValue = {
  message: UIMessage;
  index: number;
};

export const MessagesCtx = createContext<MessagesContextValue | undefined>(
  undefined,
);
export const MessageItemCtx = createContext<
  MessageItemContextValue | undefined
>(undefined);

export function useMessagesContext() {
  const ctx = use(MessagesCtx);
  if (!ctx) {
    throw new Error('useMessagesContext must be used within <Messages>');
  }
  return ctx;
}

export function useMessagesStatus() {
  const ctx = use(MessagesCtx);
  const { status } = useAgentStatus();
  // Soft fallback: status is derivable from agent context, so we don't
  // force callers to wrap in <Messages.Root> or pass status= just to read it.
  return ctx?.status ?? status;
}

export function useMessageItem() {
  const ctx = use(MessageItemCtx);
  if (!ctx) {
    throw new Error('useMessageItem must be used within <Messages.Item>');
  }
  return ctx;
}
