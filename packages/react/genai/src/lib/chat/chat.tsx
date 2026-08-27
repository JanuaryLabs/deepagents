import { useChat } from '@ai-sdk/react';
import {
  type ChatOnDataCallback,
  type ChatTransport,
  type UIDataTypes,
  type UIMessage,
  type UITools,
  lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai';
import { AnimatePresence, motion } from 'motion/react';
import * as React from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';

import { cn } from '@deepagents/react-shadcn';

import type { ComponentRegistry } from '../tools/registry.ts';
import { useAgentMeta } from './agent-context.tsx';
import { handleToolAutoApproval } from './tool-auto-approval.ts';

export function useAgentChatSetup(props: {
  chatId: string;
  transport: ChatTransport<UIMessage<unknown, UIDataTypes, UITools>>;
  initialMessages?: UIMessage<unknown, UIDataTypes, UITools>[];
  registry?: ComponentRegistry;
  onData?: ChatOnDataCallback<UIMessage<unknown, UIDataTypes, UITools>>;
}) {
  const chat = useChat({
    id: props.chatId,
    experimental_throttle: 50,
    messages: props.initialMessages,
    transport: props.transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      await handleToolAutoApproval(chat, props.registry, toolCall);
    },
    onData: props.onData,
  });

  return chat;
}

export function ChatBot(
  props: React.PropsWithChildren<{
    className?: string;
  }>,
) {
  return <AgentScrollArea {...props} />;
}

export function AgentScrollArea(
  props: React.PropsWithChildren<{ className?: string }>,
) {
  const { scrollRef, contentRef } = useStickToBottom({
    initial: 'smooth',
  });
  const { hasSubmitted } = useAgentMeta();
  return (
    <div
      id="agent"
      data-slot="agent"
      className={cn(
        '@container mx-auto h-full w-full overflow-y-auto',
        props.className,
      )}
      ref={scrollRef}
    >
      <div
        ref={contentRef}
        data-slot="content"
        className={cn(
          'relative mx-auto flex w-full flex-col',
          hasSubmitted ? 'min-h-full' : 'h-full justify-center',
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

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
            {props.children ?? 'How can I help today?'}
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
      {hasSubmitted && props.children && (
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
