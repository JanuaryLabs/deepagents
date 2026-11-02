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
  use,
  useCallback,
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
    () =>
      new ChatManager({
        chat: agent,
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
    [agent.id, agent.messages, agent.status, agent.error],
  );

  const hasSubmitted = !!skipInitialView || agent.messages.length > 0;
  const metaValue = useMemo(() => ({ hasSubmitted }), [hasSubmitted]);

  return (
    <ChatManagerContext value={manager}>
      <AgentConfigContext value={configValue}>
        <AgentStatusContext value={agent.status}>
          <AgentMessagesContext value={messagesValue}>
            <AgentMetaContext value={metaValue}>{children}</AgentMetaContext>
          </AgentMessagesContext>
        </AgentStatusContext>
      </AgentConfigContext>
    </ChatManagerContext>
  );
}

export function useAgent() {
  const context = use(AgentConfigContext);
  if (context === undefined) {
    throw new Error('useAgent must be used within an AgentProvider');
  }
  return context;
}

export function useAgentStatus() {
  const status = use(AgentStatusContext);
  return { status };
}

export function useAgentMeta() {
  const meta = use(AgentMetaContext);
  if (meta === undefined) {
    throw new Error('useAgentMeta must be used within an AgentProvider');
  }
  return meta;
}

export function useAgentMessages() {
  const context = use(AgentMessagesContext);
  if (context === undefined) {
    throw new Error('useAgentMessages must be used within an AgentProvider');
  }
  return context;
}

export function useChatManager() {
  const manager = use(ChatManagerContext);
  if (!manager) {
    throw new Error('useChatManager must be used within an AgentProvider');
  }
  return manager;
}
