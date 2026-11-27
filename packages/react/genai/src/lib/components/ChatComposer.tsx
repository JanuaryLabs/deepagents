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
import { type GenaiTranslate, useGenaiMessages } from '../i18n/provider.tsx';
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
  const t = useGenaiMessages();
  return (
    <Composer.AttachFiles
      aria-label={t('composer.attachFiles')}
      render={<ChatActionButton icon={<Paperclip className="size-4" />} />}
      {...props}
    />
  );
}

function ChatComposerCommandButton() {
  const { actions, meta } = useComposer('ChatComposer.CommandButton');
  const t = useGenaiMessages();

  return (
    <ChatActionButton
      data-command-button
      icon={<Plus className="size-4" />}
      aria-label={t('composer.commandMenu')}
      aria-expanded={meta.activePopup?.trigger === '/'}
      onClick={(event) => {
        event.stopPropagation();
        actions.toggleSlashMenu();
      }}
    />
  );
}

function dictationFailure(code: DictationErrorCode, t: GenaiTranslate) {
  switch (code) {
    case 'permission-denied':
      return t('dictation.permissionDenied');
    case 'no-microphone':
      return t('dictation.noMicrophone');
    case 'microphone-in-use':
      return t('dictation.microphoneInUse');
    case 'interrupted':
      return t('dictation.interrupted');
    case 'transcription-failed':
      return t('dictation.transcriptionFailed');
  }
}

function dictationLabel(state: DictationState, t: GenaiTranslate) {
  switch (state.status) {
    case 'unavailable':
      return state.reason === 'blocked'
        ? t('dictation.blocked')
        : t('dictation.unsupported');
    case 'idle':
      return t('dictation.start');
    case 'starting':
      return t('dictation.starting');
    case 'recording':
      return t('dictation.stop');
    case 'finishing':
      return t('dictation.transcribing');
    case 'failed':
      return dictationFailure(state.error.code, t);
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
  const t = useGenaiMessages();
  const label = dictationLabel(state, t);
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
              aria-label={t(
                state.status === 'finishing'
                  ? 'dictation.cancelTranscription'
                  : 'dictation.cancel',
              )}
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
