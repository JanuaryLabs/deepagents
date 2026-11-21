import { cn } from 'cn';
import {
  Loader2Icon,
  MicIcon,
  Paperclip,
  Plus,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import type { ComponentProps } from 'react';

import {
  Composer,
  type ComposerAttachFilesProps,
  type ComposerAttachmentsProps,
  type ComposerContentProps,
  type ComposerEditorProps,
  type ComposerRootProps,
  type ComposerToolbarProps,
  type DictationErrorCode,
  type DictationState,
  useComposer,
  useComposerDictation,
} from '@deepagents/react-input/browser';

import { useAgentMeta, useAgentStatus } from '../chat/agent-context.tsx';
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
        '!min-h-15 !rounded-none !border-0 !bg-transparent !shadow-none **:data-[slot=composer-editor]:!p-0',
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

function dictationFailure(code: DictationErrorCode) {
  switch (code) {
    case 'permission-denied':
      return 'Allow microphone access to use dictation';
    case 'no-microphone':
      return 'Connect a microphone to use dictation';
    case 'microphone-in-use':
      return 'Close other apps using the microphone';
    case 'interrupted':
      return 'Recording interrupted';
    case 'transcription-failed':
      return 'Unable to transcribe audio';
  }
}

function dictationLabel(state: DictationState) {
  switch (state.status) {
    case 'unavailable':
      return state.reason === 'blocked'
        ? 'Allow microphone access in your browser settings to use dictation'
        : 'Dictation is not available in this browser';
    case 'idle':
      return 'Start dictation';
    case 'starting':
      return 'Starting dictation';
    case 'recording':
      return 'Stop dictation';
    case 'finishing':
      return 'Transcribing…';
    case 'failed':
      return dictationFailure(state.error.code);
  }
}

function dictationIcon(state: DictationState) {
  switch (state.status) {
    case 'recording':
      return <SquareIcon className="size-4 fill-current" />;
    case 'starting':
    case 'finishing':
      return <Loader2Icon className="size-4 animate-spin" />;
    case 'unavailable':
    case 'idle':
    case 'failed':
      return <MicIcon className="size-4" />;
  }
}

function ChatComposerDictate() {
  const { status } = useAgentStatus();
  const { state } = useComposerDictation('ChatComposer.Dictate');
  const label = dictationLabel(state);
  const active =
    state.status === 'starting' ||
    state.status === 'recording' ||
    state.status === 'finishing';

  return (
    <>
      <Composer.Dictate
        disabled={status === 'streaming' || status === 'submitted'}
        render={
          <ChatActionButton
            icon={dictationIcon(state)}
            aria-label={label}
            title={label}
          />
        }
      />
      {active ? (
        <Composer.CancelDictation
          render={
            <ChatActionButton
              icon={<XIcon className="size-4" />}
              aria-label={
                state.status === 'finishing'
                  ? 'Cancel transcription'
                  : 'Cancel dictation'
              }
            />
          }
        />
      ) : null}
      {state.status === 'failed' ? (
        <span
          role="status"
          className="text-destructive max-w-48 truncate text-xs"
        >
          {label}
        </span>
      ) : null}
    </>
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
  Dictate: ChatComposerDictate,
};
