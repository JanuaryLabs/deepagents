import type { UIMessage } from 'ai';
import { memo, useMemo, useState } from 'react';

import { PersistedPromptText } from '@deepagents/chat-input/browser';
import {
  type UserReminderMetadata,
  stripReminders,
} from '@deepagents/context/browser';
import { cn } from '@deepagents/react-shadcn';

import { FilePart } from '../../message-parts.tsx';
import { formatUsageBreakdown, parseMetadataUsage } from '../../usage.ts';
import { useMessageItem } from '../messages-context.ts';
import { CollapsibleDisclosure } from './collapsible-disclosure.tsx';

export function MessageMetadata({
  metadata,
}: {
  metadata: UIMessage['metadata'];
}) {
  if (!metadata) return null;

  const usage = parseMetadataUsage(metadata);
  if (!usage) return null;

  return (
    <div className="text-muted-foreground mt-2 text-xs tabular-nums opacity-60">
      {formatUsageBreakdown(usage)}
    </div>
  );
}

function extractReminders(message: UIMessage): UserReminderMetadata[] {
  const raw = (message.metadata as Record<string, unknown> | undefined)
    ?.reminders;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is UserReminderMetadata => {
    if (!r || typeof r !== 'object') return false;
    const candidate: Partial<UserReminderMetadata> = r;
    return (
      typeof candidate.id === 'string' &&
      candidate.id.length > 0 &&
      typeof candidate.text === 'string' &&
      candidate.text.trim().length > 0
    );
  });
}

function ReminderItem({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-pressed={expanded}
        className={cn(
          'hover:text-foreground w-full cursor-pointer text-left whitespace-pre-wrap',
          !expanded && 'line-clamp-3',
        )}
      >
        {text}
      </button>
    </li>
  );
}

function UserMessageReminders({
  reminders,
}: {
  reminders: UserReminderMetadata[];
}) {
  const [open, setOpen] = useState(false);
  if (reminders.length === 0) return null;
  const label = `${reminders.length} reminder${reminders.length === 1 ? '' : 's'} attached`;
  return (
    <CollapsibleDisclosure
      label={label}
      open={open}
      onOpenChange={setOpen}
      className="mt-1"
      triggerClassName="text-muted-foreground hover:text-foreground gap-1.5 text-xs"
      contentClassName="mt-1.5"
      chevronClassName="size-3.5"
    >
      <ul className="border-ink-12 text-muted-foreground space-y-1 border-l pl-3 text-xs">
        {reminders.map((r) => (
          <ReminderItem key={r.id} text={r.text} />
        ))}
      </ul>
    </CollapsibleDisclosure>
  );
}

function UserBubbleShell({
  body,
  reminders,
  metadata,
}: {
  body: React.ReactNode;
  reminders: UserReminderMetadata[];
  metadata?: UIMessage['metadata'];
}) {
  return (
    <div className="bg-secondary flex max-w-[80%] flex-col gap-3 rounded-lg p-3">
      <div className="flex-1 space-y-3">{body}</div>
      <UserMessageReminders reminders={reminders} />
      {metadata !== undefined && <MessageMetadata metadata={metadata} />}
    </div>
  );
}

export function UserMessageContent({
  message: rawMessage,
}: {
  message: UIMessage;
}) {
  const remindersRef = (
    rawMessage.metadata as Record<string, unknown> | undefined
  )?.reminders;
  const { message, reminders } = useMemo(
    () => ({
      message: stripReminders(rawMessage),
      reminders: extractReminders(rawMessage),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remindersRef is the load-bearing change signal: rawMessage identity often stays stable while its `metadata.reminders` array swaps in place during streaming
    [rawMessage, remindersRef],
  );
  const rawAlias = (rawMessage.metadata as Record<string, unknown> | undefined)
    ?.alias;
  const alias =
    typeof rawAlias === 'string' && rawAlias.trim().length > 0
      ? rawAlias
      : undefined;

  if (alias) {
    return (
      <UserBubbleShell
        reminders={reminders}
        body={<div className="text-sm whitespace-pre-wrap">{alias}</div>}
      />
    );
  }

  return (
    <UserBubbleShell
      reminders={reminders}
      metadata={message.metadata}
      body={message.parts.map((part, partIndex) => {
        if (part.type === 'text') {
          return (
            <div
              key={`${message.id}-${partIndex}-text`}
              className="text-sm whitespace-pre-wrap"
            >
              <PersistedPromptText text={part.text} />
            </div>
          );
        }
        if (part.type === 'file') {
          return (
            <FilePart
              key={`${message.id}-${partIndex}-file`}
              filename={part.filename}
              mediaType={part.mediaType}
            />
          );
        }
        return null;
      })}
    />
  );
}

export const MessagesUserBubble = memo(function MessagesUserBubble({
  className,
}: {
  className?: string;
}) {
  const { message } = useMessageItem();

  return (
    <div className={cn('flex justify-end', className)}>
      <UserMessageContent message={message} />
    </div>
  );
});
