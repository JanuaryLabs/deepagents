import { type UIMessage, type UseChatHelpers } from '@ai-sdk/react';
import type {
  ChatOnDataCallback,
  ChatOnFinishCallback,
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
import type { ZukhrufChatTransport } from './zukhruf-chat-transport.ts';

export interface AgentConfigContextValue {
  chatId: string;
  registry?: ComponentRegistry;
  debugMode?: boolean;
  toggleDebugMode: () => void;
  clearChat: () => void;
  resetChat: (prompt?: string) => void;
  /** Settles once the submission is queued or sent; rejects when a file upload fails. */
  submit: (submission: ChatSubmission) => Promise<void>;
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
const AgentMetaContext = createContext<{ hasSubmitted: boolean } | undefined>(
  undefined,
);

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
  onFinish,
  onResetChat,
  queueEnabled = true,
}: {
  chatId: string;
  children: ReactNode;
  skipInitialView?: boolean;
  debugMode?: boolean;
  registry?: ComponentRegistry;
  initialMessages?: UIMessage[];
  transport: ChatTransport<UIMessage<unknown, UIDataTypes, UITools>> &
    Pick<ZukhrufChatTransport, 'uploadFile'>;
  /** Enable the AI SDK's automatic stream resumption. */
  resume?: boolean;
  /** Observes every streamed data part, transient ones included. */
  onData?: ChatOnDataCallback<UIMessage<unknown, UIDataTypes, UITools>>;
  /** Observes response termination; inspect isAbort, isDisconnect, and isError. */
  onFinish?: ChatOnFinishCallback<UIMessage<unknown, UIDataTypes, UITools>>;
  onResetChat: (chatId: string) => void;
  queueEnabled?: boolean;
}) {
  const agent = useAgentChatSetup({
    chatId,
    transport,
    registry,
    initialMessages,
    resume,
    onData,
    onFinish,
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
        uploadFile: transport.uploadFile.bind(transport),
        onResetChat: forwardResetChat,
      }),
  );
  manager.bind(agent);
  const queue = useSyncExternalStore(
    manager.subscribe,
    () => manager.queue,
    () => manager.queue,
  );

  useEffect(() => {
    manager.initialize(chatId);
  }, [manager, chatId]);

  useEffect(() => {
    manager.processQueue(queue);
  }, [manager, agent.status, queue]);

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

  // SDK methods change with the chat ID; snapshots stay stable until updated.
  const messagesValue = useMemo(
    () => agent,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agent.id, agent.messages, agent.status, agent.error],
  );

  const hasSubmitted = !!skipInitialView || agent.messages.length > 0;
  const metaValue = useMemo(() => ({ hasSubmitted }), [hasSubmitted]);

  return (
    <ChatManagerContext value={manager}>
      <AgentConfigContext.Provider value={configValue}>
        <AgentStatusContext.Provider value={agent.status}>
          <AgentMessagesContext.Provider value={messagesValue}>
            <AgentMetaContext.Provider value={metaValue}>
              {children}
            </AgentMetaContext.Provider>
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
  const meta = useContext(AgentMetaContext);
  if (meta === undefined) {
    throw new Error('useAgentMeta must be used within an AgentProvider');
  }
  return meta;
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
