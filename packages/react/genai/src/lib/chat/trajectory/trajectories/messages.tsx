import type { ReasoningUIPart, ToolUIPart, UIMessage } from 'ai';
import { isStaticToolUIPart } from 'ai';
import { AlertCircle } from 'lucide-react';
import { type ReactNode, memo, useState } from 'react';

import { cn } from '@deepagents/react-shadcn';

import { TextShimmer } from '../../../components/text-shimmer.tsx';
import { DynamicToolDebug } from '../../../components/tool-debug.tsx';
import { Response } from '../../../elements/Response.tsx';
import {
  isActiveClientInputTool,
  resolveToolEntry,
} from '../../../tools/helpers.ts';
import { useAgent } from '../../agent-context.tsx';
import {
  AssistantTextPart,
  FilePart,
  ToolPartContent,
  useShowDebug,
} from '../../message-parts.tsx';
import {
  useMessageItem,
  useMessagesContext,
  useMessagesStatus,
} from '../messages-context.ts';
import { ToolLabelInline } from '../tool-label.tsx';
import { CollapsibleDisclosure } from './collapsible-disclosure.tsx';
import {
  CopyAssistantMessageAction,
  CopyAssistantMessageJsonAction,
  MessagesActions,
  RegenerateAction,
} from './message-actions.tsx';
import { MessagesError } from './messages-error.tsx';
import { MessagesItem, MessagesList, MessagesRoot } from './messages-shell.tsx';
import { thinking } from './thinking-hint.ts';
import { MessagesUserBubble } from './user-message.tsx';

function ErrorPill({
  message,
  className,
}: {
  message: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'text-destructive/90 bg-destructive/10 flex items-start gap-2 rounded-md px-3 py-2 text-sm',
        className,
      )}
    >
      <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function StaticToolPart({ part }: { part: ToolUIPart }) {
  const config = useAgent();
  const { toolEntry } = resolveToolEntry(part, config.registry);

  if (toolEntry && isActiveClientInputTool(toolEntry, part.state)) {
    const label = toolEntry.label?.(part);
    if (!label) return null;

    const Icon = label.icon;
    const firstArg = label.args ? Object.values(label.args)[0] : undefined;

    return (
      <div className="text-muted-foreground flex items-center text-xs">
        {Icon && <Icon className="size-3.5" />}
        <span className="ms-2 font-mono">{label.name}</span>
        {firstArg && <span className="truncate">({firstArg})</span>}
      </div>
    );
  }

  const label = toolEntry?.label?.(part);

  return (
    <>
      {label && <ToolLabelInline label={label} part={part} />}
      {label?.isError && label.detail && <ErrorPill message={label.detail} />}
      <ToolPartContent part={part} />
    </>
  );
}

function ReasoningPart({ part }: { part: ReasoningUIPart }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div
      data-copy-exclude="assistant-snapshot"
      className="bg-muted/30 prose max-w-auto prose-sm text-muted-foreground border-border mb-4 w-full min-w-full rounded-lg p-3"
    >
      <CollapsibleDisclosure
        label="Reasoning"
        open={isOpen}
        onOpenChange={setIsOpen}
        className="text-xs"
        triggerClassName="w-full gap-x-2 text-sm hover:opacity-80"
        contentClassName="mt-2"
      >
        <Response mode="static">{part.text}</Response>
      </CollapsibleDisclosure>
    </div>
  );
}

function AssistantPart({ part }: { part: UIMessage['parts'][number] }) {
  const { elements } = useMessagesContext();
  const debugMode = useShowDebug();

  if (part.type === 'text') {
    if (part.providerMetadata?.openai?.phase === 'commentary') {
      return null;
    }
    return <AssistantTextPart text={part.text} elements={elements} />;
  }

  if (part.type === 'dynamic-tool') {
    return debugMode ? <DynamicToolDebug part={part} /> : null;
  }

  if (isStaticToolUIPart(part)) {
    return <StaticToolPart part={part} />;
  }

  if (part.type === 'reasoning' && part.text) {
    return debugMode ? <ReasoningPart part={part} /> : null;
  }

  if (part.type === 'file') {
    return <FilePart filename={part.filename} mediaType={part.mediaType} />;
  }

  return null;
}

const MessagesAssistantContent = memo(function MessagesAssistantContent({
  className,
}: {
  className?: string;
}) {
  const { message } = useMessageItem();

  return (
    <div className={cn('flex-1 space-y-3', className)}>
      {message.parts.map((part, partIndex) => (
        <AssistantPart key={`${message.id}-${partIndex}`} part={part} />
      ))}
    </div>
  );
});

function ThinkingIndicator({
  className,
  label,
}: {
  className?: string;
  label?: string;
}) {
  const displayText = label
    ? label
        .split('\n')
        .filter((line) => line.trim())
        .pop() || 'Thinking...'
    : 'Thinking...';

  return (
    <div role="status" className={cn('flex items-start', className)}>
      <TextShimmer className="text-muted-foreground line-clamp-2 text-sm">
        {displayText}
      </TextShimmer>
    </div>
  );
}

function MessagesThinking() {
  const status = useMessagesStatus();
  const { messages } = useMessagesContext();
  const thinkingHint = thinking(status, messages[messages.length - 1]);

  if (!thinkingHint) return null;

  return <ThinkingIndicator label={thinkingHint} className="mt-2" />;
}

export const Messages = {
  Root: MessagesRoot,
  List: MessagesList,
  Item: MessagesItem,
  UserBubble: MessagesUserBubble,
  AssistantContent: MessagesAssistantContent,
  Thinking: MessagesThinking,
  Error: MessagesError,
  Actions: MessagesActions,
  CopyAction: CopyAssistantMessageAction,
  RegenerateAction,
  CopyDebugJsonAction: CopyAssistantMessageJsonAction,
};
