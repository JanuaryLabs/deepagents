import { type UIMessage, type UseChatHelpers } from '@ai-sdk/react';
import type {
  ChatOnDataCallback,
  ChatStatus,
  ChatTransport,
  UIDataTypes,
  UITools,
} from 'ai';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { ComponentRegistry } from '../tools/registry.ts';
import { ChatManager, type ChatSubmission } from './chat-manager.ts';
import { useAgentChatSetup } from './chat.tsx';

export interface AgentConfigContextValue {
  chatId: string;
  registry?: ComponentRegistry;
  debugMode?: boolean;
  toggleDebugMode: () => void;
  clearChat: () => void;
  resetChat: (prompt?: string) => void;
  submit: (submission: ChatSubmission) => void;
  setChat: (messages: UIMessage[]) => void;
  getTriggeringUserMessage: (toolCallId: string) => UIMessage | null;
  getLastUserMessageId: () => string | null;
  stop: () => void;
}

type AgentMessagesContextValue = UseChatHelpers<
  UIMessage<unknown, UIDataTypes, UITools>
>;

const AgentConfigContext = createContext<AgentConfigContextValue | undefined>(
  undefined,
);
const AgentStatusContext = createContext<ChatStatus>('ready');
const AgentMessagesContext = createContext<
  AgentMessagesContextValue | undefined
>(undefined);
const ChatManagerContext = createContext<ChatManager | null>(null);

export function AgentProvider({
  chatId,
  children,
  skipInitialView,
  debugMode: debugOn,
  registry,
  initialMessages,
  transport,
  resume,
  onData,
  onResetChat,
  queueEnabled = true,
}: {
  chatId: string;
  children: ReactNode;
  skipInitialView?: boolean;
  debugMode?: boolean;
  registry?: ComponentRegistry;
  initialMessages?: UIMessage[];
  transport: ChatTransport<UIMessage<unknown, UIDataTypes, UITools>>;
  /** Reconnect to the chat's active stream once, on mount. */
  resume?: boolean;
  /** Observes every streamed data part, transient ones included. */
  onData?: ChatOnDataCallback<UIMessage<unknown, UIDataTypes, UITools>>;
  onResetChat: (chatId: string) => void;
  queueEnabled?: boolean;
}) {
  const agent = useAgentChatSetup({
    chatId,
    transport,
    registry,
    initialMessages,
    onData,
  });

  const [debugMode, setDebugMode] = useState(debugOn);
  const toggleDebugMode = useCallback(() => setDebugMode((prev) => !prev), []);

  const onResetChatRef = useRef(onResetChat);
  useEffect(() => {
    onResetChatRef.current = onResetChat;
  }, [onResetChat]);
  const forwardResetChat = useCallback((id: string) => {
    onResetChatRef.current(id);
  }, []);

  const [manager] = useState(
    // eslint-disable-next-line react-hooks/refs -- forwardResetChat reads its ref only at call time: ChatManager stores the callback (chat-manager.ts constructor) and invokes it solely from resetChat(), never during construction/render. The analyzer cannot see past the opaque constructor.
    () =>
      new ChatManager({
        queueEnabled,
        hasSubmitted: !!skipInitialView || (initialMessages?.length ?? 0) > 0,
        initialMessages,
        enableResume: resume,
        onResetChat: forwardResetChat,
      }),
  );
  manager.bind(agent);

  useEffect(() => {
    manager.initialize(chatId);
  }, [manager, chatId]);

  useEffect(() => {
    manager.syncStatus(agent.status);
  }, [manager, agent.status]);

  const managerMethods = useMemo(
    () => ({
      clearChat: () => manager.clearChat(),
      resetChat: (prompt?: string) => manager.resetChat(prompt),
      submit: (submission: ChatSubmission) => manager.submit(submission),
      setChat: (messages: UIMessage[]) => manager.setChat(messages),
      getTriggeringUserMessage: (id: string) =>
        manager.getTriggeringUserMessage(id),
      getLastUserMessageId: () => manager.getLastUserMessageId(),
      stop: () => manager.stop(),
    }),
    [manager],
  );

  const configValue = useMemo<AgentConfigContextValue>(
    () => ({
      chatId,
      registry,
      debugMode,
      toggleDebugMode,
      ...managerMethods,
    }),
    [chatId, registry, debugMode, toggleDebugMode, managerMethods],
  );

  // useChat() returns a new object every render, but its fields (messages, status, error)
  // are from useSyncExternalStore — referentially stable when unchanged. Methods (sendMessage,
  // setMessages, etc.) are stable chatRef.current accessors. So memoizing on the three
  // changing fields is safe: cached object's methods still point to the same Chat instance.
  const messagesValue = useMemo(
    () => agent,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.messages, agent.status, agent.error],
  );

  return (
    <ChatManagerContext value={manager}>
      <AgentConfigContext.Provider value={configValue}>
        <AgentStatusContext.Provider value={agent.status}>
          <AgentMessagesContext.Provider value={messagesValue}>
            {children}
          </AgentMessagesContext.Provider>
        </AgentStatusContext.Provider>
      </AgentConfigContext.Provider>
    </ChatManagerContext>
  );
}

export function useAgent() {
  const context = useContext(AgentConfigContext);
  if (context === undefined) {
    throw new Error('useAgent must be used within an AgentProvider');
  }
  return context;
}

export function useAgentStatus() {
  const status = useContext(AgentStatusContext);
  return { status };
}

export function useAgentMeta() {
  const manager = useContext(ChatManagerContext);
  if (!manager) {
    throw new Error('useAgentMeta must be used within an AgentProvider');
  }
  const hasSubmitted = useSyncExternalStore(
    manager.subscribe,
    () => manager.hasSubmitted,
    () => manager.hasSubmitted,
  );
  return { hasSubmitted };
}

export function useAgentMessages() {
  const context = useContext(AgentMessagesContext);
  if (context === undefined) {
    throw new Error('useAgentMessages must be used within an AgentProvider');
  }
  return context;
}

export function useChatManager() {
  const manager = useContext(ChatManagerContext);
  if (!manager) {
    throw new Error('useChatManager must be used within an AgentProvider');
  }
  return manager;
}
