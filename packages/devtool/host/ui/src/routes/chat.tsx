import { type UIMessage, validateUIMessages } from 'ai';
import { useState, useSyncExternalStore } from 'react';
import {
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
  useLoaderData,
  useNavigate,
  useRevalidator,
  redirect,
} from 'react-router';

import {
  AgentHeader,
  AgentProvider,
  ChatBot,
  ChatComposer,
  CompactMessages,
  MessageQueue,
  PendingToolInput,
  SubmitButton,
  ZukhrufChatTransport,
  serializeToolsRegistry,
  useAgent,
  useAgentMessages,
  useAgentMeta,
  useAgentStatus,
  useChatManager,
} from '@deepagents/react-genai';
import { Composer, useComposer } from '@deepagents/react-input/browser';
import { cn } from '@deepagents/react-shadcn';

import { INTERACTIVE_ELEMENTS } from '../app/elements.tsx';
import { loadRuntime } from '../app/runtime-data.ts';
import { TOOL_REGISTRY } from '../app/tools.tsx';

export async function loader(args: LoaderFunctionArgs) {
  const { params, request } = args;
  const chatId =
    params.sessionId ?? new URL(request.url).searchParams.get('chatId');
  if (!chatId) {
    throw redirect(`/chat?chatId=${encodeURIComponent(crypto.randomUUID())}`);
  }
  const runtime = await loadRuntime(request.signal);
  const conversation = runtime.history.find(
    (entry) => entry.chatId === chatId,
  );
  const api = runtime.discovery?.capabilities.chat.href;
  if (
    !api ||
    (!params.sessionId && !conversation && !runtime.historyError)
  ) {
    return {
      ...runtime,
      chatId,
      conversation,
      initialMessages: undefined,
      sessionExists: false,
      sessionError: false,
    };
  }
  try {
    const response = await fetch(`${api}/${encodeURIComponent(chatId)}`, {
      signal: request.signal,
    });
    if (response.status === 404 && !params.sessionId) {
      return {
        ...runtime,
        chatId,
        conversation,
        initialMessages: undefined,
        sessionExists: false,
        sessionError: false,
      };
    }
    if (!response.ok) {
      throw new Error(`Session request failed: ${response.status}`);
    }
    const body = (await response.json()) as { messages?: unknown };
    if (!Array.isArray(body.messages)) {
      throw new Error('Session response did not include messages');
    }
    return {
      ...runtime,
      chatId,
      conversation,
      initialMessages: await validateUIMessages({ messages: body.messages }),
      sessionExists: true,
      sessionError: false,
    };
  } catch {
    return {
      ...runtime,
      chatId,
      conversation,
      initialMessages: undefined,
      sessionExists: false,
      sessionError: true,
    };
  }
}

export function shouldRevalidate({
  currentParams,
  currentUrl,
  nextParams,
  nextUrl,
}: ShouldRevalidateFunctionArgs) {
  return (
    currentParams.sessionId !== nextParams.sessionId ||
    currentUrl.searchParams.get('chatId') !==
      nextUrl.searchParams.get('chatId')
  );
}

export function Component() {
  const { chatId } = useLoaderData<typeof loader>();
  return <ChatSessionBoundary key={chatId} chatId={chatId} />;
}

function ChatSessionBoundary({ chatId }: { chatId: string }) {
  const { discovery, initialMessages, sessionError, sessionExists } =
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
      chatId={chatId}
      initialMessages={initialMessages}
      sessionExists={sessionExists}
      supportsUploads={discovery.capabilities.uploads !== undefined}
    />
  );
}

function ChatSession({
  api,
  chatId,
  initialMessages,
  sessionExists,
  supportsUploads,
}: {
  api: string;
  chatId: string;
  initialMessages?: UIMessage[];
  sessionExists: boolean;
  supportsUploads: boolean;
}) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [transport] = useState(
    () =>
      new ZukhrufChatTransport({
        api,
        tools: serializeToolsRegistry(TOOL_REGISTRY),
        elements: INTERACTIVE_ELEMENTS,
      }),
  );

  return (
    <AgentProvider
      chatId={chatId}
      initialMessages={initialMessages}
      onFinish={() => void revalidate()}
      onResetChat={(nextChatId) =>
        navigate(`/chat?chatId=${encodeURIComponent(nextChatId)}`)
      }
      resume={sessionExists}
      registry={TOOL_REGISTRY}
      transport={transport}
    >
      <ChatBot className="**:data-[slot='content']:max-w-3xl">
        <AgentHeader.Root className="px-6">
          <AgentHeader.Hero>How can I help?</AgentHeader.Hero>
        </AgentHeader.Root>
        <ChatMessages />
        <ChatInput supportsUploads={supportsUploads} />
      </ChatBot>
    </AgentProvider>
  );
}

function ChatMessages() {
  const { error, messages, regenerate, status } = useAgentMessages();
  if (messages.length === 0 && !error) return null;
  return (
    <CompactMessages.Root
      className="mb-8 min-h-0 flex-1 px-6"
      messages={messages}
      elements={INTERACTIVE_ELEMENTS}
      status={status}
    >
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
      <CompactMessages.Error error={error} onRetry={regenerate} />
      <CompactMessages.Thinking />
    </CompactMessages.Root>
  );
}

function ChatInput({ supportsUploads }: { supportsUploads: boolean }) {
  const { submit } = useAgent();
  const { hasSubmitted } = useAgentMeta();
  const { status } = useAgentStatus();
  const isRunning = status === 'submitted' || status === 'streaming';
  return (
    <div
      className={cn(
        'w-full px-6 pb-6',
        hasSubmitted && 'bg-background sticky bottom-0 mt-auto pt-2',
      )}
    >
      <PendingToolInput className="bg-background">
        <ChatComposer.Provider
          isTaskRunning={isRunning}
          onSubmit={(submission, context) => {
            const files = submission.items.flatMap((item) =>
              item.type === 'image' ? [item.file] : [],
            );
            if (!supportsUploads && files.length > 0) {
              return Promise.reject(
                new Error('This runtime does not support image uploads'),
              );
            }
            return submit({
              prompt: submission.prompt,
              persistedPrompt: submission.persistedPrompt,
              editableSource: context.editableSource,
              files,
            });
          }}
        >
          <ChatComposer.Root>
            <QueuedMessagesStrip />
            <ChatComposer.Popup />
            <ChatComposer.Content>
              <ChatComposer.AttachedImages />
              <ChatComposer.Editor placeholder="Message Zukhruf…" />
              <ChatComposer.Error />
            </ChatComposer.Content>
            <ChatComposer.Toolbar>
              {supportsUploads && <ChatComposer.AttachImage />}
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
