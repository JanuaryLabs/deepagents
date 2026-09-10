import type { UIMessage } from 'ai';
import { memo, useMemo, useState } from 'react';

import {
  type UserReminderMetadata,
  stripReminders,
} from '@deepagents/context/browser';
import { PersistedPromptText } from '@deepagents/react-input/browser';
import { AttachmentGroup, AttachmentMedia, cn } from '@deepagents/react-shadcn';

import { formatUsageBreakdown, parseMetadataUsage } from '../../usage.ts';
import { uploadReceiptSchema } from '../../zukhruf-chat-transport.ts';
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

function extractUploads(message: UIMessage) {
  const raw = (message.metadata as Record<string, unknown> | undefined)
    ?.uploads;
  return Array.isArray(raw)
    ? raw.flatMap((value) => {
        const receipt = uploadReceiptSchema.safeParse(value);
        return receipt.success ? [receipt.data] : [];
      })
    : [];
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

function UploadTile({
  upload,
}: {
  upload: { url: string; name: string; mediaType: string };
}) {
  if (upload.mediaType.startsWith('video/')) {
    return (
      <AttachmentMedia
        variant="image"
        className="size-36 rounded-2xl"
        title={upload.name}
      >
        <video
          src={upload.url}
          aria-label={upload.name}
          muted
          playsInline
          preload="metadata"
          className="size-full object-cover"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-2xl text-white drop-shadow"
        >
          ▶
        </span>
      </AttachmentMedia>
    );
  }
  if (upload.mediaType.startsWith('audio/')) {
    return (
      <AttachmentMedia
        variant="icon"
        className="h-36 w-48 flex-col gap-1 rounded-2xl px-3 text-xs"
        title={upload.name}
        aria-label={upload.name}
      >
        <span aria-hidden className="text-2xl">
          ♪
        </span>
        <span className="text-foreground w-full truncate text-center">
          {upload.name}
        </span>
        <span className="text-muted-foreground">{upload.mediaType}</span>
      </AttachmentMedia>
    );
  }
  return (
    <AttachmentMedia variant="image" className="size-36 rounded-2xl">
      <img src={upload.url} alt={upload.name} />
    </AttachmentMedia>
  );
}

function UserMessageAttachments({ message }: { message: UIMessage }) {
  const uploads = extractUploads(message);
  if (uploads.length === 0) return null;

  return (
    <AttachmentGroup
      role="list"
      aria-label="Attached files"
      className="max-w-full gap-2 py-0"
    >
      {uploads.map((upload) => (
        <div key={upload.path} role="listitem" data-slot="attachment">
          <UploadTile upload={upload} />
        </div>
      ))}
    </AttachmentGroup>
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
    <div className="flex w-full min-w-0 flex-col items-end gap-3">
      <UserMessageAttachments message={message} />
      <UserBubbleShell
        reminders={reminders}
        metadata={message.metadata}
        body={message.parts.map((part, partIndex) =>
          part.type === 'text' ? (
            <div
              key={`${message.id}-${partIndex}-text`}
              className="text-sm whitespace-pre-wrap"
            >
              <PersistedPromptText text={part.text} />
            </div>
          ) : null,
        )}
      />
    </div>
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
