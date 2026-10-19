import { Chat, useChat } from '@ai-sdk/react';
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
import { AnimatePresence, motion } from 'motion/react';
import * as React from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';

import type { ComponentRegistry } from '../tools/registry.ts';
import { useAgentMeta } from './agent-context.tsx';
import { completeRenderedClientTool } from './client-tool-output.ts';

type AgentUIMessage = UIMessage<unknown, UIDataTypes, UITools>;

interface AgentChatSetupProps {
  chatId: string;
  transport: ChatTransport<AgentUIMessage>;
  initialMessages?: AgentUIMessage[];
  registry?: ComponentRegistry;
  /** Reconnect to the chat's active stream once, when its Chat is created. */
  resume?: boolean;
  onData?: ChatOnDataCallback<AgentUIMessage>;
  onFinish?: ChatOnFinishCallback<AgentUIMessage>;
}

/**
 * Creates one Chat per chatId and renders it with useChat. The Chat is owned
 * here, not by useChat, so its live status and messages can be read between
 * renders; its callbacks and transport read the latest props.
 */
export function useAgentChatSetup(props: AgentChatSetupProps) {
  const latest = React.useRef(props);
  React.useEffect(() => {
    latest.current = props;
  });

  const chat = React.useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- the callbacks read `latest` only when the Chat calls them (a send, a stream part, a tool call), never while it is constructed during render. The analyzer cannot see past the opaque constructor; agent-context.tsx has the same case.
      new Chat<AgentUIMessage>({
        id: props.chatId,
        messages: props.initialMessages,
        transport: {
          sendMessages: (options) =>
            latest.current.transport.sendMessages(options),
          reconnectToStream: (options) =>
            latest.current.transport.reconnectToStream(options),
        },
        sendAutomaticallyWhen: (options) =>
          lastAssistantMessageIsCompleteWithToolCalls(options) ||
          lastAssistantMessageIsCompleteWithApprovalResponses(options),
        async onToolCall({ toolCall }) {
          await completeRenderedClientTool(
            chat,
            latest.current.registry,
            toolCall,
          );
        },
        onData: (part) => latest.current.onData?.(part),
        onFinish: (event) => latest.current.onFinish?.(event),
      }),
    // A new Chat per conversation; initialMessages seed only that Chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.chatId],
  );

  React.useEffect(
    () => () => {
      void chat.stop();
    },
    [chat],
  );

  const helpers = useChat<AgentUIMessage>({
    chat,
    experimental_throttle: 50,
    resume: props.resume,
  });
  return { chat, helpers };
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
