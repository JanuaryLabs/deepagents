import type { UseChatHelpers } from '@ai-sdk/react';
import type {
  ChatOnDataCallback,
  ChatOnFinishCallback,
  ChatStatus,
  ChatTransport,
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
} from 'react';

import type { ComponentRegistry } from '../tools/registry.ts';
import type { AgentUIMessage } from './agent-ui-message.ts';
import { ChatManager, type ChatSubmission } from './chat-manager.ts';
import { useAgentChatSetup } from './chat.tsx';
import { prefillTransport } from './prefill-transport.ts';
import type { ZukhrufChatTransport } from './zukhruf-chat-transport.ts';

export interface AgentConfigContextValue {
  chatId: string;
  registry?: ComponentRegistry;
  debugMode?: boolean;
  toggleDebugMode: () => void;
  clearChat: () => void;
  /** Starts a new chat, sending `submission` as its first message when given. */
  resetChat: (
    submission?: Pick<ChatSubmission, 'prompt' | 'persistedPrompt'>,
  ) => void;
  /** Settles once the submission is queued or sent; rejects when a file upload fails. */
  submit: (submission: ChatSubmission) => Promise<void>;
  setChat: (messages: AgentUIMessage[]) => void;
  getTriggeringUserMessage: (toolCallId: string) => AgentUIMessage | null;
  getLastUserMessageId: () => string | null;
  /**
   * Stops the answer at once and resolves once the server has cancelled its
   * turn; rejects when the cancel fails, and the turn may still run. When the
   * server refuses the cancel, the chat resumes the turn's stream. A submit
   * made meanwhile is sent after the cancel settles, or after that resumed
   * turn ends.
   */
  stop: () => Promise<void>;
}

type AgentMessagesContextValue = UseChatHelpers<AgentUIMessage>;

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
}: {
  chatId: string;
  children: ReactNode;
  skipInitialView?: boolean;
  debugMode?: boolean;
  registry?: ComponentRegistry;
  initialMessages?: AgentUIMessage[];
  transport: ChatTransport<AgentUIMessage> &
    Pick<ZukhrufChatTransport, 'uploadFile' | 'cancel'>;
  /** Enable the AI SDK's automatic stream resumption. */
  resume?: boolean;
  /** Observes every streamed data part, transient ones included. */
  onData?: ChatOnDataCallback<AgentUIMessage>;
  /** Observes response termination; inspect isAbort, isDisconnect, and isError. */
  onFinish?: ChatOnFinishCallback<AgentUIMessage>;
  onResetChat: (chatId: string) => void;
}) {
  const sendingTransport = useMemo(
    () => prefillTransport(transport),
    [transport],
  );
  const agent = useAgentChatSetup({
    chatId,
    transport: sendingTransport,
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
        uploadFile: transport.uploadFile.bind(transport),
        cancel: transport.cancel.bind(transport),
        onResetChat: forwardResetChat,
      }),
  );
  manager.bind(agent);

  useEffect(() => manager.initialize(chatId), [manager, chatId]);

  const managerMethods = useMemo(
    () => ({
      clearChat: () => manager.clearChat(),
      resetChat: (
        submission?: Pick<ChatSubmission, 'prompt' | 'persistedPrompt'>,
      ) => manager.resetChat(submission),
      submit: (submission: ChatSubmission) => manager.submit(submission),
      setChat: (messages: AgentUIMessage[]) => manager.setChat(messages),
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
    [
      agent.id,
      agent.messages,
      agent.status,
      agent.error,
      agent.experimental_queuedMessages,
    ],
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
