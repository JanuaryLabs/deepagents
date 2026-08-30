import { type UIMessage, validateUIMessages } from 'ai';
import { useState, useSyncExternalStore } from 'react';
import {
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useRevalidator,
} from 'react-router';

import {
  AgentHeader,
  AgentProvider,
  ChatBot,
  ChatComposer,
  MessageQueue,
  Messages,
  PendingToolInput,
  SubmitButton,
  useAgent,
  useAgentMessages,
  useAgentMeta,
  useAgentStatus,
  useChatManager,
} from '@deepagents/react-genai';
import { Composer, useComposer } from '@deepagents/react-input/browser';
import { cn } from '@deepagents/react-shadcn';

import { loadRuntime } from '../app/runtime-data.ts';
import { ZukhrufChatTransport } from '../app/zukhruf-chat-transport.ts';

const TOOL_REGISTRY = {};

export async function loader(args: LoaderFunctionArgs) {
  const { params, request } = args;
  const runtime = await loadRuntime(request.signal);
  const conversation = params.sessionId
    ? runtime.history.find(({ chatId }) => chatId === params.sessionId)
    : runtime.history[0];
  const api = runtime.discovery?.capabilities.chat.href;
  if (!api || !params.sessionId) {
    return {
      ...runtime,
      conversation,
      initialMessages: undefined,
      sessionError: false,
    };
  }
  try {
    const response = await fetch(
      `${api}/${encodeURIComponent(params.sessionId)}`,
      { signal: request.signal },
    );
    if (!response.ok) {
      throw new Error(`Session request failed: ${response.status}`);
    }
    const body = (await response.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) {
      throw new Error('Session response did not include messages');
    }
    return {
      ...runtime,
      conversation,
      initialMessages: await validateUIMessages({ messages: body.messages }),
      sessionError: false,
    };
  } catch {
    return {
      ...runtime,
      conversation,
      initialMessages: undefined,
      sessionError: true,
    };
  }
}

export function shouldRevalidate({
  currentParams,
  nextParams,
}: ShouldRevalidateFunctionArgs) {
  return currentParams.sessionId !== nextParams.sessionId;
}

export function ChatRoute() {
  const { sessionId } = useParams();
  const location = useLocation();
  const locationState = location.state as { chatKey?: string } | null;
  const chatKey =
    locationState?.chatKey ??
    sessionId ??
    new URLSearchParams(location.search).get('draft') ??
    location.key;
  return (
    <ChatSessionBoundary
      key={chatKey}
      chatKey={chatKey}
      sessionId={sessionId}
    />
  );
}

function ChatSessionBoundary({
  chatKey,
  sessionId,
}: {
  chatKey: string;
  sessionId?: string;
}) {
  const [initialSessionId] = useState(sessionId);
  const { discovery, initialMessages, sessionError } =
    useLoaderData<typeof loader>();
  const api = discovery?.capabilities.chat.href;

  if (!api) {
    return <ChatStatus>Development runtime unavailable.</ChatStatus>;
  }
  if (sessionError) {
    return <ChatStatus>Unable to load this conversation.</ChatStatus>;
  }

  return (
    <ChatSession
      api={api}
      chatKey={chatKey}
      initialMessages={initialMessages}
      sessionId={initialSessionId}
    />
  );
}

function ChatSession({
  api,
  chatKey,
  initialMessages,
  sessionId,
}: {
  api: string;
  chatKey: string;
  initialMessages?: UIMessage[];
  sessionId?: string;
}) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [transport] = useState(
    () =>
      new ZukhrufChatTransport({
        api,
        sessionId,
        onSession: (acceptedSessionId) => {
          void navigate(`/chat/${encodeURIComponent(acceptedSessionId)}`, {
            replace: true,
            state: { chatKey },
          });
          void revalidate();
        },
      }),
  );

  return (
    <AgentProvider
      chatId={sessionId ?? chatKey}
      initialMessages={initialMessages}
      onResetChat={() =>
        navigate(`/chat?draft=${encodeURIComponent(crypto.randomUUID())}`)
      }
      resume={Boolean(sessionId)}
      registry={TOOL_REGISTRY}
      transport={transport}
    >
      <ChatBot className="max-w-5xl">
        <AgentHeader.Root className="px-6">
          <AgentHeader.Hero>How can I help?</AgentHeader.Hero>
        </AgentHeader.Root>
        <ChatMessages />
        <ChatInput />
      </ChatBot>
    </AgentProvider>
  );
}

function ChatMessages() {
  const { error, messages, regenerate, status } = useAgentMessages();
  if (messages.length === 0 && !error) return null;
  return (
    <Messages.Root
      className="mx-auto mb-4 min-h-0 w-full max-w-3xl flex-1 px-6"
      messages={messages}
      status={status}
    >
      <Messages.List>
        {messages.map((message, index) => (
          <Messages.Item key={message.id} message={message} index={index}>
            {message.role === 'user' ? (
              <Messages.UserBubble />
            ) : (
              <Messages.AssistantContent />
            )}
          </Messages.Item>
        ))}
      </Messages.List>
      <Messages.Error error={error} onRetry={regenerate} />
      <Messages.Thinking />
    </Messages.Root>
  );
}

function ChatInput() {
  const { submit } = useAgent();
  const { hasSubmitted } = useAgentMeta();
  const { status } = useAgentStatus();
  const isRunning = status === 'submitted' || status === 'streaming';
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-3xl px-6 pb-6',
        hasSubmitted && 'bg-background sticky bottom-0 mt-auto pt-2',
      )}
    >
      <PendingToolInput className="bg-background">
        <ChatComposer.Provider
          isTaskRunning={isRunning}
          onSubmit={(submission, context) =>
            submit({
              prompt: submission.prompt,
              persistedPrompt: submission.persistedPrompt,
              editableSource: context.editableSource,
            })
          }
        >
          <ChatComposer.Root>
            <QueuedMessagesStrip />
            <ChatComposer.Popup />
            <ChatComposer.Content>
              <ChatComposer.Editor placeholder="Message Zukhruf…" />
              <ChatComposer.Error />
            </ChatComposer.Content>
            <ChatComposer.Toolbar>
              <ChatSubmitButton />
            </ChatComposer.Toolbar>
          </ChatComposer.Root>
        </ChatComposer.Provider>
      </PendingToolInput>
    </div>
  );
}

function QueuedMessagesStrip() {
  const manager = useChatManager();
  const queue = useSyncExternalStore(manager.subscribe, () => manager.queue);
  if (queue.length === 0) return null;

  return (
    <MessageQueue.Root>
      {queue.map((message) => (
        <MessageQueue.Item key={message.id}>
          <MessageQueue.Icon />
          <MessageQueue.Text>{message.persistedPrompt}</MessageQueue.Text>
          <MessageQueue.Remove
            onClick={() => manager.removeFromQueue(message.id)}
          />
        </MessageQueue.Item>
      ))}
    </MessageQueue.Root>
  );
}

function ChatSubmitButton() {
  const { state } = useComposer('ChatSubmitButton');
  const { stop } = useAgent();
  const { status } = useAgentStatus();
  const hasDraft = state.text.trim().length > 0;
  const isRunning = status === 'submitted' || status === 'streaming';

  if (isRunning && !hasDraft) {
    return (
      <SubmitButton
        className="ml-auto"
        type="button"
        variant="stop"
        onClick={stop}
      />
    );
  }
  return (
    <Composer.Submit
      render={
        <SubmitButton
          className="ml-auto"
          type="button"
          variant="send"
          disabled={!hasDraft}
        />
      }
    />
  );
}

function ChatStatus({ children }: { children: string }) {
  return <p className="text-muted-foreground p-8 text-sm">{children}</p>;
}
