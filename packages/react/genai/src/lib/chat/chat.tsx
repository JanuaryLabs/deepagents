import { useChat } from '@ai-sdk/react';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@zukhruf/shadcn';
import {
  type ChatOnDataCallback,
  type ChatOnFinishCallback,
  type ChatTransport,
  type UIDataTypes,
  type UIMessage,
  type UITools,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';
import { cn } from 'cn';
import { ArrowDownIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import * as React from 'react';

import { useGenaiMessages } from '../i18n/provider.tsx';
import type { ComponentRegistry } from '../tools/registry.ts';
import { useAgentMeta } from './agent-context.tsx';
import { ChatBotScrollerContext } from './chat-bot-scroller.ts';
import { completeRenderedClientTool } from './client-tool-output.ts';

type AgentUIMessage = UIMessage<unknown, UIDataTypes, UITools>;

interface AgentChatSetupProps {
  chatId: string;
  transport: ChatTransport<AgentUIMessage>;
  initialMessages?: AgentUIMessage[];
  registry?: ComponentRegistry;
  /** Enable the AI SDK's automatic stream resumption. */
  resume?: boolean;
  onData?: ChatOnDataCallback<AgentUIMessage>;
  onFinish?: ChatOnFinishCallback<AgentUIMessage>;
}

export function useAgentChatSetup(props: AgentChatSetupProps) {
  const helpers = useChat<AgentUIMessage>({
    id: props.chatId,
    messages: props.initialMessages,
    transport: props.transport,
    throttle: 50,
    experimental_queue: true,
    resume: props.resume,
    onData: props.onData,
    onFinish: props.onFinish,
    sendAutomaticallyWhen: (options) =>
      lastAssistantMessageIsCompleteWithToolCalls(options) ||
      lastAssistantMessageIsCompleteWithApprovalResponses(options),
    onToolCall({ toolCall }) {
      // The SDK queues tool output behind this callback; awaiting it deadlocks.
      void completeRenderedClientTool(helpers, props.registry, toolCall);
    },
  });
  return helpers;
}

export type ChatBotProps = React.PropsWithChildren<{
  className?: string;
  /**
   * Follow the stream while the reader is at the end. Off by default: a new
   * user message moves to the top and its answer grows below it.
   */
  autoScroll?: boolean;
  /** Pixels of the previous message kept in view above a new user message. */
  scrollPreviousItemPeek?: number;
  /** Pixels kept clear at the top of the view, such as under a sticky header. */
  scrollMargin?: number;
}>;

function ChatBotRoot({
  className,
  children,
  autoScroll = false,
  scrollPreviousItemPeek,
  scrollMargin,
}: ChatBotProps) {
  const { hasSubmitted } = useAgentMeta();
  return (
    <MessageScrollerProvider
      autoScroll={autoScroll}
      scrollPreviousItemPeek={scrollPreviousItemPeek}
      scrollMargin={scrollMargin}
    >
      <MessageScroller
        id="agent"
        data-slot="agent"
        className={cn('@container mx-auto w-full', className)}
      >
        <MessageScrollerViewport>
          <div
            data-slot="content"
            className={cn(
              'relative mx-auto flex w-full flex-col',
              hasSubmitted ? 'min-h-full' : 'h-full justify-center',
            )}
          >
            <ChatBotScrollerContext value={true}>
              {children}
            </ChatBotScrollerContext>
          </div>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
ChatBotRoot.displayName = 'ChatBot';

/**
 * Scrolls to the end of the chat. It shows while something is below the
 * view, and floats 16px above the place where it is rendered: last in the
 * chat, or first inside a sticky composer.
 */
function ChatBotScrollButton(props: { className?: string }) {
  const t = useGenaiMessages();
  return (
    <div
      data-slot="chat-scroll-button"
      className="pointer-events-none sticky bottom-0 z-10 h-0"
    >
      <MessageScrollerButton
        direction="end"
        className={cn('pointer-events-auto', props.className)}
      >
        <ArrowDownIcon />
        <span className="sr-only">{t('chat.scrollToBottom')}</span>
      </MessageScrollerButton>
    </div>
  );
}
ChatBotScrollButton.displayName = 'ChatBot.ScrollButton';

export const ChatBot = Object.assign(ChatBotRoot, {
  ScrollButton: ChatBotScrollButton,
});

function AgentHeaderRoot(props: {
  className?: string;
  children: React.ReactNode;
}) {
  const { hasSubmitted } = useAgentMeta();
  return (
    <motion.div
      layout
      className={cn(
        hasSubmitted
          ? cn(
              'bg-background sticky top-0 z-10 shrink-0 space-y-1 backdrop-blur-md',
              props.className,
            )
          : 'relative flex justify-center py-4',
      )}
      transition={{
        layout: { type: 'tween', ease: [0.4, 0, 0.2, 1], duration: 0.4 },
      }}
    >
      <div className={cn(hasSubmitted ? 'text-left' : 'space-y-3 text-center')}>
        {props.children}
      </div>
    </motion.div>
  );
}
AgentHeaderRoot.displayName = 'AgentHeader.Root';

function AgentHeaderHero(props: {
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { hasSubmitted } = useAgentMeta();
  const t = useGenaiMessages();
  return (
    <AnimatePresence mode="sync">
      {!hasSubmitted && (
        <motion.div
          key="agent-header-initial"
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <h1 className="flex items-center justify-center gap-2 text-2xl font-medium tracking-tight">
            {props.icon}
            {props.children ?? t('chat.greeting')}
          </h1>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
AgentHeaderHero.displayName = 'AgentHeader.Hero';

function AgentHeaderTitle(props: { children?: React.ReactNode }) {
  return (
    <motion.h2
      layout="position"
      className="text-muted-foreground text-sm font-medium"
    >
      {props.children}
    </motion.h2>
  );
}
AgentHeaderTitle.displayName = 'AgentHeader.Title';

function AgentHeaderDescription(props: { children?: React.ReactNode }) {
  const { hasSubmitted } = useAgentMeta();
  return (
    <AnimatePresence>
      {hasSubmitted && Boolean(props.children) && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
          className="text-muted-foreground text-sm"
        >
          {props.children}
        </motion.p>
      )}
    </AnimatePresence>
  );
}
AgentHeaderDescription.displayName = 'AgentHeader.Description';

export const AgentHeader = {
  Root: AgentHeaderRoot,
  Hero: AgentHeaderHero,
  Title: AgentHeaderTitle,
  Description: AgentHeaderDescription,
};
