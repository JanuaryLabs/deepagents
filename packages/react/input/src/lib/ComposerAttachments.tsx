import { Button } from '@base-ui/react/button';
import { X } from 'lucide-react';
import { type ComponentPropsWithoutRef, useEffect, useState } from 'react';

import { cn } from '@deepagents/react-shadcn';

import { useComposerContext } from './ComposerContext.ts';
import type { ComposerState } from './ComposerTypes.ts';

export type ComposerAttachmentsProps = ComponentPropsWithoutRef<'div'>;

type AttachmentPreviewProps = {
  placeholder: string;
  file: File;
};

export function ComposerAttachments({
  className,
  ...props
}: ComposerAttachmentsProps) {
  const { state, attachedImages } = useComposerContext('Composer.Attachments');
  const attachments = state.imageAttachments.filter((attachment) =>
    attachedImages.has(attachment.id),
  );
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div
      role="list"
      aria-label="Attached files"
      className={cn('flex flex-wrap gap-2', className)}
      {...props}
    >
      {attachments.map((attachment) => (
        <ComposerAttachment key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

function ComposerAttachment({
  attachment: { id, placeholder, media },
}: {
  attachment: ComposerState['imageAttachments'][number];
}) {
  const { attachedImages, disabled, actions } = useComposerContext(
    'Composer.Attachments',
  );
  const file = attachedImages.get(id);
  if (!file) {
    return null;
  }
  return (
    <div role="listitem" className="relative">
      {media === 'video' ? (
        <ComposerAttachedVideoTile placeholder={placeholder} file={file} />
      ) : media === 'audio' ? (
        <ComposerAttachedFileChip
          placeholder={placeholder}
          file={file}
          glyph="♪"
        />
      ) : (
        <ComposerImagePreview placeholder={placeholder} file={file} />
      )}
      <Button
        type="button"
        aria-label={`Remove ${placeholder}`}
        disabled={disabled}
        onClick={() => actions.removeImageAttachment(id)}
        className="bg-background text-foreground border-border hover:bg-muted absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border disabled:opacity-50"
      >
        <X aria-hidden className="size-3" />
      </Button>
    </div>
  );
}

function useObjectUrl(file: File) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return objectUrl;
}

function ComposerImagePreview({ placeholder, file }: AttachmentPreviewProps) {
  const objectUrl = useObjectUrl(file);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return objectUrl === null ? null : objectUrl === failedUrl ? (
    <ComposerAttachedFileChip placeholder={placeholder} file={file} glyph="🖼" />
  ) : (
    <img
      src={objectUrl}
      alt={placeholder}
      title={file.name}
      className="border-border size-16 rounded-md border object-cover"
      onError={() => setFailedUrl(objectUrl)}
    />
  );
}

function ComposerAttachedVideoTile({
  placeholder,
  file,
}: AttachmentPreviewProps) {
  const objectUrl = useObjectUrl(file);
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <div
      role="img"
      aria-label={placeholder}
      title={file.name}
      className="border-border bg-muted relative size-16 overflow-hidden rounded-md border"
    >
      <video
        src={objectUrl ?? undefined}
        muted
        playsInline
        preload="metadata"
        className="size-full object-cover"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-lg text-white drop-shadow"
      >
        ▶
      </span>
      {duration !== null && Number.isFinite(duration) ? (
        <span className="absolute right-0.5 bottom-0.5 rounded bg-black/70 px-1 text-[10px] leading-4 text-white">
          {formatDuration(duration)}
        </span>
      ) : null}
    </div>
  );
}

function formatDuration(seconds: number) {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function ComposerAttachedFileChip({
  placeholder,
  file,
  glyph,
}: AttachmentPreviewProps & { glyph: string }) {
  return (
    <div
      role="img"
      aria-label={placeholder}
      title={file.name}
      className="border-border bg-muted text-muted-foreground flex h-16 max-w-48 flex-col justify-center gap-0.5 rounded-md border px-2 text-xs"
    >
      <span className="text-foreground truncate">
        <span aria-hidden>{glyph} </span>
        {file.name || placeholder}
      </span>
      <span className="truncate">{file.type || 'file'}</span>
    </div>
  );
}
