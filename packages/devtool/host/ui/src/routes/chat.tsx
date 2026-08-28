import type { UIMessage } from 'ai';
import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { Composer, useComposer } from '@deepagents/react-input/browser';
import {
  AgentHeader,
  AgentProvider,
  ChatBot,
  ChatComposer,
  Messages,
  PendingToolInput,
  SubmitButton,
  useAgent,
  useAgentMessages,
  useAgentStatus,
} from '@deepagents/react-genai';

import {
  queryClient,
  useRuntimeData,
  useSessionMessages,
} from '../app/runtime-data.ts';
import { ZukhrufChatTransport } from '../app/zukhruf-chat-transport.ts';

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
  const { discovery, discoveryPending } = useRuntimeData();
  const api = discovery?.capabilities.chat.href;
  const session = useSessionMessages(api, initialSessionId);

  if (discoveryPending || (initialSessionId && session.isPending)) {
    return <ChatStatus>Loading chat…</ChatStatus>;
  }
  if (!api) {
    return <ChatStatus>Development runtime unavailable.</ChatStatus>;
  }
  if (session.isError) {
    return <ChatStatus>Unable to load this conversation.</ChatStatus>;
  }

  return (
    <ChatSession
      api={api}
      chatKey={chatKey}
      initialMessages={session.data}
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
          void queryClient.invalidateQueries({
            queryKey: ['runtime', 'history'],
          });
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
      transport={transport}
    >
      <ChatBot className="max-w-5xl">
        <AgentHeader.Root className="px-6">
          <AgentHeader.Hero>How can I help?</AgentHeader.Hero>
          <AgentHeader.Title>Zukhruf</AgentHeader.Title>
          <AgentHeader.Description>
            Chat with the development runtime over HTTP.
          </AgentHeader.Description>
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
  const { status } = useAgentStatus();
  const isRunning = status === 'submitted' || status === 'streaming';
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-6">
      <PendingToolInput>
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
