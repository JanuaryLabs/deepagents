import { Paperclip, Plus } from 'lucide-react';
import type { ComponentProps } from 'react';

import {
  Composer,
  type ComposerAttachFilesProps,
  type ComposerAttachmentsProps,
  type ComposerContentProps,
  type ComposerEditorProps,
  type ComposerRootProps,
  type ComposerToolbarProps,
  useComposer,
} from '@deepagents/react-input/browser';
import { cn } from '@deepagents/react-shadcn';

import { useAgentMeta } from '../chat/agent-context.tsx';
import { ChatActionButton } from './ChatAction.tsx';

function ChatComposerProvider({ className, ...props }: ComposerRootProps) {
  const { hasSubmitted } = useAgentMeta();
  return (
    <Composer.Root
      hasInteracted={hasSubmitted}
      className={cn(
        'bg-background sticky bottom-0 rounded-t-2xl border-0 **:data-[slot=composer-editor]:!min-h-15',
        className,
      )}
      {...props}
    />
  );
}

function ChatComposerRoot({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'border-border bg-card focus-within:border-primary/80 focus-within:ring-primary/15 relative rounded-2xl border',
        className,
      )}
      {...props}
    />
  );
}

function ChatComposerContent({ className, ...props }: ComposerContentProps) {
  return (
    <Composer.Content
      className={cn('space-y-1 px-3.5 pt-3', className)}
      {...props}
    />
  );
}

function ChatComposerEditor({ className, ...props }: ComposerEditorProps) {
  return (
    <Composer.Editor
      className={cn(
        '!min-h-15 !rounded-none !border-0 !bg-transparent !shadow-none **:data-[slot=composer-editor]:!p-0 **:data-[slot=composer-placeholder]:!p-0',
        className,
      )}
      {...props}
    />
  );
}

function ChatComposerAttachments({
  className,
  ...props
}: ComposerAttachmentsProps) {
  return (
    <Composer.Attachments className={cn('pb-1.5', className)} {...props} />
  );
}

function ChatComposerToolbar({ className, ...props }: ComposerToolbarProps) {
  return (
    <Composer.Toolbar className={cn('p-1.5 pt-0', className)} {...props} />
  );
}

function ChatComposerAttachFiles(props: ComposerAttachFilesProps) {
  return (
    <Composer.AttachFiles
      aria-label="Attach files"
      render={<ChatActionButton icon={<Paperclip className="size-4" />} />}
      {...props}
    />
  );
}

function ChatComposerCommandButton() {
  const { actions, meta } = useComposer('ChatComposer.CommandButton');

  return (
    <ChatActionButton
      data-command-button
      icon={<Plus className="size-4" />}
      aria-label="Toggle command menu"
      aria-expanded={meta.activePopup?.trigger === '/'}
      onClick={(event) => {
        event.stopPropagation();
        actions.toggleSlashMenu();
      }}
    />
  );
}

export const ChatComposer = {
  Provider: ChatComposerProvider,
  Root: ChatComposerRoot,
  Popup: Composer.Popup,
  Content: ChatComposerContent,
  Attachments: ChatComposerAttachments,
  Editor: ChatComposerEditor,
  Error: Composer.Error,
  Toolbar: ChatComposerToolbar,
  CommandButton: ChatComposerCommandButton,
  AttachFiles: ChatComposerAttachFiles,
};
